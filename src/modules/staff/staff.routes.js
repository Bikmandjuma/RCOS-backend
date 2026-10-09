import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { newOpaqueToken, hashToken } from "../../shared/tokens.js";
import { normalizeEmail } from "../../shared/phone.js";
import { audit } from "../../shared/audit.js";
import { env } from "../../config/env.js";

export const staffRouter = Router();
staffRouter.use(authenticate);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const staffView = (u) => ({
  id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, isActive: u.isActive,
  lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  role: { id: u.role.id, name: u.role.name, isOwner: u.role.isOwner },
});

const invitationView = (i) => ({
  id: i.id, email: i.email, fullName: i.fullName, role: { id: i.role.id, name: i.role.name },
  expiresAt: i.expiresAt, createdAt: i.createdAt,
});

staffRouter.get("/", requirePermission("staff.view"), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({ where: { tenantId: req.auth.tenantId }, include: { role: true }, orderBy: { createdAt: "asc" } });
  return ok(res, users.map(staffView));
}));

// Roles the signed-in person is allowed to hand out: never Owner, never more access than they hold.
staffRouter.get("/assignable-roles", asyncHandler(async (req, res) => {
  if (!req.auth.can("staff.create") && !req.auth.can("staff.update")) throw forbidden();
  const roles = await prisma.role.findMany({ where: { tenantId: req.auth.tenantId, isOwner: false }, include: { permissions: true }, orderBy: { createdAt: "asc" } });
  const allowed = roles.filter((r) => req.auth.role.isOwner || r.permissions.every((p) => req.auth.permissions.has(p.permission)));
  return ok(res, allowed.map((r) => ({ id: r.id, name: r.name, description: r.description })));
}));

staffRouter.get("/invitations", requirePermission("staff.view"), asyncHandler(async (req, res) => {
  const list = await prisma.staffInvitation.findMany({
    where: { tenantId: req.auth.tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { role: true }, orderBy: { createdAt: "desc" },
  });
  return ok(res, list.map(invitationView));
}));

staffRouter.post("/invitations", requirePermission("staff.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    email: z.string().trim().toLowerCase().email("Enter a valid email address"),
    fullName: z.string().trim().max(80).optional().or(z.literal("")),
    roleId: z.string().min(1, "Choose a role"),
  }), req.body);
  const { tenantId } = req.auth;

  const role = await prisma.role.findFirst({ where: { id: b.roleId, tenantId } });
  if (!role) throw badRequest("Choose a valid role.");
  if (role.isOwner) throw badRequest("There can only be one Owner. Choose another role.");
  // Nobody can hand out more access than they have themselves.
  if (!req.auth.role.isOwner) {
    const perms = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
    if (perms.some((p) => !req.auth.permissions.has(p.permission))) throw forbidden("You can't invite someone into a role with more access than yours.");
  }
  const email = normalizeEmail(b.email);
  if (await prisma.user.findUnique({ where: { email } })) throw conflict("Someone with this email already has an account.");

  const token = newOpaqueToken();
  const invitation = await prisma.$transaction(async (tx) => {
    // A new invite replaces any pending one for the same email.
    await tx.staffInvitation.updateMany({ where: { tenantId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    return tx.staffInvitation.create({
      data: { tenantId, roleId: role.id, email, fullName: b.fullName || null, tokenHash: hashToken(token), invitedById: req.auth.user.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      include: { role: true },
    });
  });
  await audit(req, { action: "staff.invited", entityType: "invitation", entityId: invitation.id, summary: `Invited ${email} as ${role.name}` });
  // The link is only returned now; we store a hash. (Emailing it arrives with the notifications phase.)
  return created(res, { invitation: invitationView(invitation), inviteUrl: `${env.clientUrl}/invite/${token}` }, "Invitation created.");
}));

staffRouter.delete("/invitations/:id", requirePermission("staff.create"), asyncHandler(async (req, res) => {
  const inv = await prisma.staffInvitation.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId, acceptedAt: null, revokedAt: null } });
  if (!inv) throw notFound("Invitation not found.");
  await prisma.staffInvitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
  await audit(req, { action: "staff.invitation_revoked", entityType: "invitation", entityId: inv.id, summary: `Revoked the invitation for ${inv.email}` });
  return ok(res, null, "Invitation revoked.");
}));

staffRouter.patch("/:id", requirePermission("staff.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ roleId: z.string().min(1).optional(), isActive: z.boolean().optional() }), req.body);
  const { tenantId } = req.auth;
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId }, include: { role: true } });
  if (!target) throw notFound("Team member not found.");
  if (target.role.isOwner) throw forbidden("The Owner's role and access can't be changed here.");

  const data = {};
  const notes = [];
  if (b.roleId && b.roleId !== target.roleId) {
    const role = await prisma.role.findFirst({ where: { id: b.roleId, tenantId } });
    if (!role) throw badRequest("Choose a valid role.");
    if (role.isOwner) throw badRequest("There can only be one Owner.");
    if (target.id === req.auth.user.id) throw forbidden("You can't change your own role.");
    if (!req.auth.role.isOwner) {
      const perms = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
      if (perms.some((p) => !req.auth.permissions.has(p.permission))) throw forbidden("You can't assign a role with more access than yours.");
    }
    data.roleId = role.id;
    notes.push(`role ${target.role.name} → ${role.name}`);
  }
  if (typeof b.isActive === "boolean" && b.isActive !== target.isActive) {
    if (target.id === req.auth.user.id) throw forbidden("You can't deactivate your own account.");
    data.isActive = b.isActive;
    notes.push(b.isActive ? "reactivated" : "deactivated");
  }
  if (!Object.keys(data).length) return ok(res, staffView(target), "No changes.");

  const updated = await prisma.user.update({ where: { id: target.id }, data, include: { role: true } });
  await audit(req, { action: "staff.updated", entityType: "user", entityId: target.id, summary: `Updated ${target.fullName}: ${notes.join(", ")}` });
  return ok(res, staffView(updated), "Team member updated.");
}));
