import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { normalizePhone } from "../../shared/phone.js";
import { statsFor, withSegment } from "./customers.service.js";

export const customersRouter = Router();
export const reviewsRouter = Router();
customersRouter.use(authenticate);
reviewsRouter.use(authenticate);

const body = z.object({
  name: z.string({ required_error: "Enter a name" }).trim().min(2, "Enter a name").max(80),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  email: z.string().trim().toLowerCase().email("Enter a valid email").optional().or(z.literal("")),
  notes: z.string().trim().max(300).optional().or(z.literal("")),
});

customersRouter.get("/", requirePermission("customers.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const q = String(req.query.search || "").trim();
  const segment = ["NEW", "REGULAR", "VIP", "INACTIVE"].includes(req.query.segment) ? req.query.segment : null;

  const counts = { NEW: 0, REGULAR: 0, VIP: 0, INACTIVE: 0 };
  const all = await prisma.customer.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 5000 });
  const stats = await statsFor(tenantId, all.map((c) => c.id));
  const decorated = all.map((c) => withSegment(c, stats.get(c.id)));
  decorated.forEach((c) => { counts[c.segment]++; });

  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, ""); // phone search compares digits only, so "788123" finds "0788 123 456"
  const matches = (c) => !needle || c.name.toLowerCase().includes(needle) || (digits.length >= 3 && (c.phone || "").replace(/\D/g, "").includes(digits));
  const filtered = decorated.filter((c) => (!segment || c.segment === segment) && matches(c));
  filtered.sort((a, b) => b.spentRwf - a.spentRwf || new Date(b.createdAt) - new Date(a.createdAt));
  return ok(res, { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize, counts, totalCustomers: all.length });
}));

customersRouter.post("/", requirePermission("customers.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(body, req.body);
  const { tenantId } = req.auth;
  const key = normalizePhone(b.phone);
  if (key && (await prisma.customer.findUnique({ where: { tenantId_phoneKey: { tenantId, phoneKey: key } } }))) throw conflict("A customer with this phone number already exists.");
  const c = await prisma.customer.create({ data: { tenantId, name: b.name, phone: b.phone || null, phoneKey: key || null, email: b.email || null, notes: b.notes || null } });
  await audit(req, { action: "customer.created", entityType: "customer", entityId: c.id, summary: `Added the customer "${c.name}"` });
  return created(res, withSegment(c), "Customer added.");
}));

async function own(tenantId, id) {
  const c = await prisma.customer.findFirst({ where: { id, tenantId } });
  if (!c) throw notFound("Customer not found.");
  return c;
}

customersRouter.get("/:id", requirePermission("customers.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const c = await own(tenantId, req.params.id);
  const [stats, orders, txns] = await Promise.all([
    statsFor(tenantId, [c.id]),
    prisma.order.findMany({ where: { tenantId, customerId: c.id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, number: true, totalRwf: true, status: true, paymentStatus: true, createdAt: true, discountRwf: true } }),
    prisma.loyaltyTransaction.findMany({ where: { tenantId, customerId: c.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const t = req.auth.tenant;
  return ok(res, {
    ...withSegment(c, stats.get(c.id)), orders,
    loyalty: { enabled: t.loyaltyEnabled, rewardPoints: t.rewardPoints, rewardName: t.rewardName, canRedeem: t.loyaltyEnabled && c.loyaltyPoints >= t.rewardPoints, transactions: txns.map((x) => ({ id: x.id, type: x.type, points: x.points, balanceAfter: x.balanceAfter, note: x.note, by: x.actorName, at: x.createdAt })) },
  });
}));

customersRouter.patch("/:id", requirePermission("customers.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(body, req.body);
  const { tenantId } = req.auth;
  const c = await own(tenantId, req.params.id);
  const key = normalizePhone(b.phone);
  if (key && key !== c.phoneKey && (await prisma.customer.findUnique({ where: { tenantId_phoneKey: { tenantId, phoneKey: key } } }))) throw conflict("Another customer already has this phone number.");
  const u = await prisma.customer.update({ where: { id: c.id }, data: { name: b.name, phone: b.phone || null, phoneKey: key || null, email: b.email || null, notes: b.notes || null } });
  await audit(req, { action: "customer.updated", entityType: "customer", entityId: c.id, summary: `Updated the customer "${u.name}"` });
  return ok(res, withSegment(u), "Customer saved.");
}));

// Deleting a customer removes their personal details and loyalty history; past orders stay as sales records.
customersRouter.delete("/:id", requirePermission("customers.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const c = await own(tenantId, req.params.id);
  await prisma.order.updateMany({ where: { tenantId, customerId: c.id }, data: { customerId: null, customerPhone: null } });
  await prisma.customer.delete({ where: { id: c.id } });
  await audit(req, { action: "customer.deleted", entityType: "customer", entityId: c.id, summary: `Deleted the customer "${c.name}" and their loyalty history` });
  return ok(res, null, "Customer deleted.");
}));

customersRouter.post("/:id/redeem", requirePermission("customers.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId, tenant, user } = req.auth;
  const c = await own(tenantId, req.params.id);
  if (!tenant.loyaltyEnabled) throw conflict("The loyalty programme is switched off.");
  const cost = tenant.rewardPoints;
  const claim = await prisma.customer.updateMany({ where: { id: c.id, tenantId, loyaltyPoints: { gte: cost } }, data: { loyaltyPoints: { decrement: cost } } });
  if (claim.count === 0) throw conflict(`${c.name} needs ${cost} points for this reward and has ${c.loyaltyPoints}.`);
  const after = await prisma.customer.findUnique({ where: { id: c.id } });
  await prisma.loyaltyTransaction.create({ data: { tenantId, customerId: c.id, type: "REDEEM", points: -cost, balanceAfter: after.loyaltyPoints, note: tenant.rewardName || "Reward", actorName: user.fullName } });
  await audit(req, { action: "loyalty.redeemed", entityType: "customer", entityId: c.id, summary: `Redeemed "${tenant.rewardName || "reward"}" for ${c.name} (${cost} points)` });
  return ok(res, { loyaltyPoints: after.loyaltyPoints }, "Reward redeemed.");
}));

customersRouter.post("/:id/points", requirePermission("customers.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ points: z.number({ required_error: "Enter the points", invalid_type_error: "Enter the points" }).int().refine((n) => n !== 0, "Enter a number other than 0").refine((n) => Math.abs(n) <= 100000, "That's too many points"), reason: z.string({ required_error: "Give a reason" }).trim().min(3, "Give a reason (at least 3 characters)").max(120) }), req.body);
  const { tenantId, user } = req.auth;
  const c = await own(tenantId, req.params.id);
  const claim = await prisma.customer.updateMany({ where: { id: c.id, tenantId, ...(b.points < 0 ? { loyaltyPoints: { gte: -b.points } } : {}) }, data: { loyaltyPoints: { increment: b.points } } });
  if (claim.count === 0) throw conflict(`${c.name} only has ${c.loyaltyPoints} points.`);
  const after = await prisma.customer.findUnique({ where: { id: c.id } });
  await prisma.loyaltyTransaction.create({ data: { tenantId, customerId: c.id, type: "ADJUST", points: b.points, balanceAfter: after.loyaltyPoints, note: b.reason, actorName: user.fullName } });
  await audit(req, { action: "loyalty.adjusted", entityType: "customer", entityId: c.id, summary: `Adjusted ${c.name}'s points by ${b.points > 0 ? "+" : ""}${b.points} (${b.reason})` });
  return ok(res, { loyaltyPoints: after.loyaltyPoints }, "Points updated.");
}));

// ---------- reviews (staff side) ----------
reviewsRouter.get("/", requirePermission("customers.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const [total, items, agg] = await Promise.all([
    prisma.review.count({ where: { tenantId } }),
    prisma.review.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.review.aggregate({ where: { tenantId, hidden: false }, _avg: { rating: true }, _count: true }),
  ]);
  const orders = await prisma.order.findMany({ where: { id: { in: items.map((r) => r.orderId) }, tenantId }, select: { id: true, number: true } });
  const num = new Map(orders.map((o) => [o.id, o.number]));
  return ok(res, { total, page, pageSize, average: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null, visibleCount: agg._count, items: items.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, author: r.authorName, orderNumber: num.get(r.orderId), hidden: r.hidden, at: r.createdAt })) });
}));

reviewsRouter.patch("/:id", requirePermission("customers.update"), asyncHandler(async (req, res) => {
  const b = parse(z.object({ hidden: z.boolean() }), req.body);
  const { tenantId } = req.auth;
  const r = await prisma.review.findFirst({ where: { id: req.params.id, tenantId } });
  if (!r) throw notFound("Review not found.");
  const u = await prisma.review.update({ where: { id: r.id }, data: { hidden: b.hidden } });
  await audit(req, { action: "review.moderated", entityType: "review", entityId: r.id, summary: `${b.hidden ? "Hid" : "Showed"} a ${r.rating}-star review from ${r.authorName}` });
  return ok(res, { id: u.id, hidden: u.hidden }, b.hidden ? "Review hidden from your public page." : "Review is public again.");
}));
