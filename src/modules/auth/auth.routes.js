import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { AppError, asyncHandler, conflict, notFound, unauthorized, badRequest } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate } from "../../shared/auth.js";
import { signAccessToken, hashToken } from "../../shared/tokens.js";
import { normalizeEmail } from "../../shared/phone.js";
import { audit } from "../../shared/audit.js";
import { provisionTenant } from "./provision.js";
import { sessionView } from "./views.js";

export const BUSINESS_TYPES = ["COFFEE_SHOP", "CAFE", "RESTAURANT", "COFFEE_LAB", "BAKERY", "FAST_FOOD", "HOTEL_RESTAURANT", "OTHER"];

const password = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(100)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Include at least one letter and one number");

const registerSchema = z.object({
  businessName: z.string().trim().min(2, "Enter your business name").max(80),
  businessType: z.enum(BUSINESS_TYPES),
  phone: z.string().trim().min(7, "Enter a phone number").max(20).regex(/^[+\d][\d\s-]{5,}$/, "Enter a valid phone number"),
  city: z.string().trim().max(60).optional().or(z.literal("")),
  slug: z.string().trim().toLowerCase().optional().or(z.literal("")),
  fullName: z.string().trim().min(2, "Enter your full name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(120),
  password,
  planCode: z.string().min(1, "Choose a plan"),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please confirm the billing terms to continue" }) }),
});

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const authRouter = Router();

authRouter.post("/register", asyncHandler(async (req, res) => {
  const b = parse(registerSchema, req.body);
  const plan = await prisma.plan.findFirst({ where: { code: b.planCode, active: true } });
  if (!plan) throw badRequest("Choose one of the available plans.");
  if (await prisma.user.findUnique({ where: { email: normalizeEmail(b.email) } })) {
    throw conflict("An account with this email already exists. Sign in instead.");
  }
  const passwordHash = await bcrypt.hash(b.password, 10);
  const { user, trialGranted } = await provisionTenant({
    business: { name: b.businessName, type: b.businessType, phone: b.phone, city: b.city, slug: b.slug || undefined, email: b.email },
    owner: { fullName: b.fullName, email: b.email },
    passwordHash,
    planCode: plan.code,
  });
  const full = await prisma.user.findUnique({ where: { id: user.id }, include: { role: { include: { permissions: true } }, tenant: { include: { subscription: true } } } });
  return created(res, { token: signAccessToken(full), user: await sessionView(full), trialGranted }, "Your business is ready.");
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { email, password: pw } = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email }, include: { role: { include: { permissions: true } }, tenant: { include: { subscription: true } } } });
  const valid = await bcrypt.compare(pw, user?.passwordHash || DUMMY_HASH);
  if (!user || !valid) throw unauthorized("Incorrect email or password.");
  if (!user.isActive) throw unauthorized("This account has been deactivated. Contact your business owner.");
  if (user.tenant.status !== "ACTIVE") throw unauthorized("This business account is suspended.");
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return ok(res, { token: signAccessToken(user), user: await sessionView(user) }, "Signed in.");
}));

authRouter.get("/me", authenticate, asyncHandler(async (req, res) => {
  return ok(res, await sessionView(req.auth.user));
}));

authRouter.post("/logout", authenticate, (req, res) => ok(res, null, "Signed out."));

authRouter.patch("/me", authenticate, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    fullName: z.string().trim().min(2).max(80),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
  }), req.body);
  const user = await prisma.user.update({
    where: { id: req.auth.user.id }, data: { fullName: b.fullName, phone: b.phone || null },
    include: { role: { include: { permissions: true } }, tenant: { include: { subscription: true } } },
  });
  return ok(res, await sessionView(user), "Profile saved.");
}));

authRouter.post("/change-password", authenticate, asyncHandler(async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const u = req.auth.user;
  if (!(await bcrypt.compare(b.currentPassword, u.passwordHash))) throw badRequest("Your current password is incorrect.");
  // Bumping tokenVersion signs out every other device.
  const updated = await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(b.newPassword, 10), tokenVersion: { increment: 1 } } });
  await audit(req, { action: "user.password_changed", entityType: "user", entityId: u.id, summary: "Changed their password" });
  return ok(res, { token: signAccessToken(updated) }, "Password changed. Other devices were signed out.");
}));

// ---- staff invitation acceptance (public) ----
async function loadInvitation(token) {
  const inv = await prisma.staffInvitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { tenant: true, role: true } });
  if (!inv || inv.revokedAt) throw notFound("This invitation link isn't valid. Ask your manager to send a new one.");
  if (inv.acceptedAt) throw conflict("This invitation has already been used. Sign in instead.");
  if (inv.expiresAt < new Date()) throw new AppError(410, "This invitation has expired. Ask your manager to send a new one.", "EXPIRED");
  return inv;
}

authRouter.get("/invitations/:token", asyncHandler(async (req, res) => {
  const inv = await loadInvitation(req.params.token);
  return ok(res, { email: inv.email, fullName: inv.fullName, roleName: inv.role.name, businessName: inv.tenant.name, expiresAt: inv.expiresAt });
}));

authRouter.post("/invitations/:token/accept", asyncHandler(async (req, res) => {
  const inv = await loadInvitation(req.params.token);
  const b = parse(z.object({ fullName: z.string().trim().min(2).max(80), password, phone: z.string().trim().max(20).optional().or(z.literal("")) }), req.body);
  if (await prisma.user.findUnique({ where: { email: inv.email } })) throw conflict("An account with this email already exists. Sign in instead.");

  const passwordHash = await bcrypt.hash(b.password, 10);
  const user = await prisma.$transaction(async (tx) => {
    const claim = await tx.staffInvitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
    if (claim.count === 0) throw conflict("This invitation has already been used.");
    return tx.user.create({
      data: { tenantId: inv.tenantId, roleId: inv.roleId, email: inv.email, passwordHash, fullName: b.fullName, phone: b.phone || null, lastLoginAt: new Date() },
      include: { role: { include: { permissions: true } }, tenant: { include: { subscription: true } } },
    });
  });
  await audit(req, { tenantId: inv.tenantId, actor: user, action: "staff.joined", entityType: "user", entityId: user.id, summary: `${user.fullName} joined as ${inv.role.name}` });
  return created(res, { token: signAccessToken(user), user: await sessionView(user) }, "Welcome aboard.");
}));
