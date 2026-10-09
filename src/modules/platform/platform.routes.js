import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { asyncHandler, badRequest, conflict, forbidden, notFound, unauthorized } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { signPlatformToken, verifyPlatformToken } from "../../shared/tokens.js";
import { DAY_MS, buildSubscriptionView } from "../billing/subscription.js";

export const platformRouter = Router();

const DUMMY = bcrypt.hashSync("not-a-real-password", 10);
const viewUser = (u) => ({ id: u.id, email: u.email, fullName: u.fullName, role: u.role });

platformRouter.post("/login", asyncHandler(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
  const u = await prisma.platformUser.findUnique({ where: { email: b.email } });
  const valid = await bcrypt.compare(b.password, u?.passwordHash || DUMMY);
  if (!u || !valid || !u.isActive) throw unauthorized("Incorrect email or password.");
  await prisma.platformUser.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
  return ok(res, { token: signPlatformToken(u), user: viewUser(u) }, "Signed in.");
}));

const authenticate = asyncHandler(async (req, _res, next) => {
  const token = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try { payload = verifyPlatformToken(token); } catch { throw unauthorized("Your session has expired. Please sign in again."); }
  const u = await prisma.platformUser.findUnique({ where: { id: payload.sub } });
  if (!u || !u.isActive || u.tokenVersion !== payload.tv) throw unauthorized("Your session has expired. Please sign in again.");
  req.admin = u;
  next();
});
const superOnly = (req, _res, next) => (req.admin.role === "SUPER_ADMIN" ? next() : next(forbidden("Support accounts are read-only.")));

platformRouter.use(authenticate);
platformRouter.get("/me", (req, res) => ok(res, viewUser(req.admin)));

async function logEvent(req, action, summary) {
  await prisma.platformEvent.create({ data: { actorId: req.admin.id, actorName: req.admin.fullName, action, summary } });
}
async function tenantAudit(req, tenantId, action, summary) {
  // Restaurants can see what the platform did to their account.
  await prisma.auditLog.create({ data: { tenantId, actorName: `RestaurantOS support (${req.admin.fullName})`, action, entityType: "tenant", entityId: tenantId, summary } });
}

// ---------- shared: every tenant with its derived state ----------
async function loadTenants() {
  const [tenants, plans, owners] = await Promise.all([
    prisma.tenant.findMany({ include: { subscription: true }, orderBy: { createdAt: "desc" }, take: 5000 }),
    prisma.plan.findMany(),
    prisma.user.findMany({ where: { role: { isOwner: true } }, select: { tenantId: true, email: true, fullName: true, lastLoginAt: true } }),
  ]);
  const owner = new Map(owners.map((o) => [o.tenantId, o]));
  const now = new Date();
  const since7 = new Date(now.getTime() - 7 * DAY_MS), since30 = new Date(now.getTime() - 30 * DAY_MS);
  const [orders7, orders30] = await Promise.all([
    prisma.order.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since7 } }, _count: true }),
    prisma.order.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since30 } }, _count: true }),
  ]);
  const o7 = new Map(orders7.map((x) => [x.tenantId, x._count])), o30 = new Map(orders30.map((x) => [x.tenantId, x._count]));
  return { now, plans, rows: tenants.map((t) => {
    const sub = t.subscription ? buildSubscriptionView(t.subscription, plans, now) : null;
    const state = t.status === "SUSPENDED" ? "suspended" : !sub ? "expired" : sub.status === "EXPIRED" ? "expired" : sub.phase === "ACTIVE" ? "paying" : "trialing";
    const ow = owner.get(t.id);
    const flags = [];
    if (t.status === "ACTIVE" && ow?.lastLoginAt && now - ow.lastLoginAt > 21 * DAY_MS) flags.push("No sign-in for 21+ days");
    if (t.status === "ACTIVE" && sub?.hasAccess && !(o7.get(t.id) > 0)) flags.push("No orders in 7 days");
    if (sub?.hasAccess && !sub.canceledAt && sub.daysLeft <= 3) flags.push("Access ends within 3 days");
    return { id: t.id, name: t.name, slug: t.slug, businessType: t.businessType, city: t.city, status: t.status, state, suspendedReason: t.suspendedReason, createdAt: t.createdAt,
      owner: ow ? { email: ow.email, name: ow.fullName, lastLoginAt: ow.lastLoginAt } : null,
      plan: sub ? sub.plan : null, trialEndsAt: t.subscription?.trialEndsAt || null, accessEndsAt: sub?.accessEndsAt || null, canceled: !!t.subscription?.canceledAt,
      orders7d: o7.get(t.id) || 0, orders30d: o30.get(t.id) || 0, flags, _sub: sub };
  }) };
}
const publicRow = ({ _sub, ...r }) => r;

platformRouter.get("/overview", asyncHandler(async (_req, res) => {
  const { now, rows } = await loadTenants();
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const [payments, gmv, orders] = await Promise.all([
    prisma.billingPayment.aggregate({ where: { status: "SUCCESSFUL", paidAt: { gte: since30 } }, _sum: { amountRwf: true }, _count: true }),
    prisma.order.aggregate({ where: { paymentStatus: "CONFIRMED", status: { not: "CANCELLED" }, paidAt: { gte: since30 } }, _sum: { totalRwf: true }, _count: true }),
    prisma.order.count({ where: { createdAt: { gte: since30 } } }),
  ]);
  const count = (s) => rows.filter((r) => r.state === s).length;
  // Monthly recurring revenue: what currently-paying, non-cancelled businesses would pay per month.
  const mrr = Math.round(rows.filter((r) => r.state === "paying" && !r.canceled && r._sub).reduce((n, r) => n + r._sub.plan.priceRwf / r._sub.plan.months, 0));
  return ok(res, {
    tenants: { total: rows.length, paying: count("paying"), trialing: count("trialing"), expired: count("expired"), suspended: count("suspended") },
    signups30d: rows.filter((r) => r.createdAt >= since30).length,
    mrrRwf: mrr, revenue30dRwf: payments._sum.amountRwf || 0, payments30d: payments._count,
    platformSales30dRwf: gmv._sum.totalRwf || 0, paidOrders30d: gmv._count, orders30d: orders,
    health: { noSignIn21d: rows.filter((r) => r.flags.includes("No sign-in for 21+ days")).length, noOrders7d: rows.filter((r) => r.flags.includes("No orders in 7 days")).length, endingSoon: rows.filter((r) => r.flags.includes("Access ends within 3 days")).length },
  });
}));

platformRouter.get("/tenants", asyncHandler(async (req, res) => {
  const { rows } = await loadTenants();
  const page = Math.max(1, parseInt(req.query.page) || 1), pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const q = String(req.query.search || "").trim().toLowerCase();
  const state = ["trialing", "paying", "expired", "suspended"].includes(req.query.state) ? req.query.state : null;
  const flagged = req.query.flagged === "1";
  const counts = { all: rows.length, trialing: 0, paying: 0, expired: 0, suspended: 0 }; rows.forEach((r) => { counts[r.state]++; });
  const list = rows.filter((r) => (!state || r.state === state) && (!flagged || r.flags.length) && (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.owner?.email || "").includes(q)));
  return ok(res, { items: list.slice((page - 1) * pageSize, page * pageSize).map(publicRow), total: list.length, page, pageSize, counts });
}));

platformRouter.get("/tenants/:id", asyncHandler(async (req, res) => {
  const { rows } = await loadTenants();
  const t = rows.find((r) => r.id === req.params.id);
  if (!t) throw notFound("Business not found.");
  const [staff, payments, audit, products, tables] = await Promise.all([
    prisma.user.count({ where: { tenantId: t.id } }),
    prisma.billingPayment.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.auditLog.findMany({ where: { tenantId: t.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.product.count({ where: { tenantId: t.id } }), prisma.diningTable.count({ where: { tenantId: t.id } }),
  ]);
  return ok(res, { ...publicRow(t), staffCount: staff, productCount: products, tableCount: tables,
    payments: payments.map((p) => ({ id: p.id, txRef: p.txRef, planCode: p.planCode, amountRwf: p.amountRwf, status: p.status, method: p.method, createdAt: p.createdAt, paidAt: p.paidAt })),
    activity: audit.map((a) => ({ id: a.id, summary: a.summary, by: a.actorName, at: a.createdAt })) });
}));

const reason = z.object({ reason: z.string({ required_error: "Give a reason" }).trim().min(3, "Give a reason (at least 3 characters)").max(200) });

platformRouter.post("/tenants/:id/suspend", superOnly, asyncHandler(async (req, res) => {
  const b = parse(reason, req.body);
  const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!t) throw notFound("Business not found.");
  if (t.status === "SUSPENDED") throw conflict("This business is already suspended.");
  await prisma.tenant.update({ where: { id: t.id }, data: { status: "SUSPENDED", suspendedReason: b.reason, suspendedAt: new Date() } });
  await tenantAudit(req, t.id, "platform.suspended", `Account suspended: ${b.reason}`);
  await logEvent(req, "tenant.suspended", `Suspended "${t.name}": ${b.reason}`);
  return ok(res, null, "Business suspended. Its staff and guests are blocked immediately.");
}));

platformRouter.post("/tenants/:id/unsuspend", superOnly, asyncHandler(async (req, res) => {
  const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!t) throw notFound("Business not found.");
  if (t.status !== "SUSPENDED") throw conflict("This business isn't suspended.");
  await prisma.tenant.update({ where: { id: t.id }, data: { status: "ACTIVE", suspendedReason: null, suspendedAt: null } });
  await tenantAudit(req, t.id, "platform.unsuspended", "Account reinstated");
  await logEvent(req, "tenant.unsuspended", `Reinstated "${t.name}"`);
  return ok(res, null, "Business reinstated.");
}));

// Gives extra days of access (e.g. to compensate for an outage or help a new business get started).
platformRouter.post("/tenants/:id/extend", superOnly, asyncHandler(async (req, res) => {
  const b = parse(reason.extend({ days: z.number({ required_error: "Enter the number of days", invalid_type_error: "Enter the number of days" }).int("Use whole days").min(1, "At least 1 day").max(365, "At most 365 days") }), req.body);
  const t = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { subscription: true } });
  if (!t?.subscription) throw notFound("Business not found.");
  const now = new Date(), sub = t.subscription, add = b.days * DAY_MS;
  const paidActive = sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  const data = paidActive ? { currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() + add) } : { trialEndsAt: new Date(Math.max(sub.trialEndsAt.getTime(), now.getTime()) + add) };
  await prisma.subscription.update({ where: { tenantId: t.id }, data });
  await tenantAudit(req, t.id, "platform.extended", `Access extended by ${b.days} day${b.days === 1 ? "" : "s"}: ${b.reason}`);
  await logEvent(req, "tenant.extended", `Extended "${t.name}" by ${b.days} days: ${b.reason}`);
  return ok(res, { accessEndsAt: (data.currentPeriodEnd || data.trialEndsAt) }, `Added ${b.days} day${b.days === 1 ? "" : "s"} of access.`);
}));

// ---------- plans (this is where prices are changed) ----------
platformRouter.get("/plans", asyncHandler(async (_req, res) => {
  const [plans, subs] = await Promise.all([prisma.plan.findMany({ orderBy: { sortOrder: "asc" } }), prisma.subscription.groupBy({ by: ["planCode"], _count: true })]);
  const used = new Map(subs.map((s) => [s.planCode, s._count]));
  return ok(res, plans.map((p) => ({ code: p.code, name: p.name, months: p.months, priceRwf: p.priceRwf, active: p.active, businesses: used.get(p.code) || 0 })));
}));

platformRouter.patch("/plans/:code", superOnly, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    priceRwf: z.number({ invalid_type_error: "Enter a price" }).int("Use whole francs").min(1, "At least 1 RWF").max(10_000_000).optional(),
    name: z.string().trim().min(2).max(40).optional(),
    active: z.boolean().optional(),
  }), req.body);
  const p = await prisma.plan.findUnique({ where: { code: req.params.code } });
  if (!p) throw notFound("Plan not found.");
  if (b.active === false && (await prisma.plan.count({ where: { active: true, NOT: { code: p.code } } })) === 0) throw badRequest("At least one plan must stay active.");
  const u = await prisma.plan.update({ where: { code: p.code }, data: b });
  const notes = [];
  if (b.priceRwf !== undefined && b.priceRwf !== p.priceRwf) notes.push(`price RWF ${p.priceRwf} → ${b.priceRwf}`);
  if (b.name && b.name !== p.name) notes.push(`renamed "${p.name}" → "${b.name}"`);
  if (b.active !== undefined && b.active !== p.active) notes.push(b.active ? "activated" : "deactivated");
  if (notes.length) await logEvent(req, "plan.updated", `Plan "${u.name}": ${notes.join(", ")}`);
  return ok(res, { code: u.code, name: u.name, months: u.months, priceRwf: u.priceRwf, active: u.active }, "Plan saved. New prices apply to future payments only.");
}));

platformRouter.get("/payments", asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const where = ["SUCCESSFUL", "PENDING", "FAILED"].includes(req.query.status) ? { status: req.query.status } : {};
  const [total, rows] = await Promise.all([prisma.billingPayment.count({ where }), prisma.billingPayment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize })]);
  const tenants = await prisma.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) } }, select: { id: true, name: true } });
  const name = new Map(tenants.map((t) => [t.id, t.name]));
  return ok(res, { total, page, pageSize, items: rows.map((p) => ({ id: p.id, business: name.get(p.tenantId), tenantId: p.tenantId, planCode: p.planCode, amountRwf: p.amountRwf, status: p.status, method: p.method, txRef: p.txRef, createdAt: p.createdAt, paidAt: p.paidAt, failureReason: p.failureReason })) });
}));

platformRouter.get("/events", asyncHandler(async (_req, res) => {
  const rows = await prisma.platformEvent.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return ok(res, rows.map((e) => ({ id: e.id, summary: e.summary, by: e.actorName, at: e.createdAt })));
}));
