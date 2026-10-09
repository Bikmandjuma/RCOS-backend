import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { asyncHandler, conflict, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { subscribe } from "../../shared/events.js";
import { audit } from "../../shared/audit.js";
import { privateAbs } from "../../shared/storage.js";
import { ACTIVE, emit, orderView, paymentOk, receiptView, transition } from "./orders.service.js";
import { logoUrl } from "../auth/views.js";
import { awardLoyalty, reverseLoyalty } from "../customers/customers.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// Live updates for the orders and kitchen screens (Server-Sent Events, one stream per open screen).
ordersRouter.get("/stream", asyncHandler(async (req, res) => {
  if (!req.auth.can("orders.view") && !req.auth.can("kitchen.view")) throw forbidden();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  const unsub = subscribe(req.auth.tenantId, (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
  const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(beat); unsub(); });
}));

// What the kitchen needs to cook right now: paid orders that are new, being prepared, or ready.
ordersRouter.get("/kitchen", requirePermission("kitchen.view"), asyncHandler(async (req, res) => {
  const list = await prisma.order.findMany({
    where: { tenantId: req.auth.tenantId, status: { in: ["PLACED", "PREPARING", "READY"] }, paymentStatus: { in: ["CONFIRMED", "NOT_REQUIRED"] } },
    include: { items: true }, orderBy: { createdAt: "asc" }, take: 100,
  });
  return ok(res, list.map((o) => orderView(o)));
}));

const VIEWS = {
  review: { paymentStatus: "PROOF_SUBMITTED", status: { not: "CANCELLED" } },
  active: { status: { in: ACTIVE } },
  done: { status: { in: ["COMPLETED", "CANCELLED"] } },
};

ordersRouter.get("/", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const view = VIEWS[req.query.view] ? req.query.view : "active";
  const where = { tenantId, ...VIEWS[view] };
  const [total, items, review, active, done] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({ where, include: { items: true }, orderBy: { createdAt: view === "done" ? "desc" : "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.order.count({ where: { tenantId, ...VIEWS.review } }),
    prisma.order.count({ where: { tenantId, ...VIEWS.active } }),
    prisma.order.count({ where: { tenantId, ...VIEWS.done } }),
  ]);
  return ok(res, { items: items.map((o) => orderView(o)), total, page, pageSize, counts: { review, active, done } });
}));

ordersRouter.get("/:id", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const o = await full(req.params.id, req.auth.tenantId);
  if (!o) throw notFound("Order not found.");
  return ok(res, orderView(o));
}));

// Payment proofs are private: only signed-in staff of the same business can open them.
ordersRouter.get("/:id/proof", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const o = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
  if (!o?.proofPath) throw notFound("No payment proof was uploaded for this order.");
  res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.sendFile(privateAbs(o.proofPath), (err) => { if (err && !res.headersSent) res.status(404).json({ statusCode: 404, message: "The proof file is missing." }); });
}));

const METHOD = z.enum(["MOBILE_MONEY", "CASH", "CARD", "OTHER"]);
const full = (id, tenantId) => prisma.order.findFirst({ where: { id, tenantId }, include: { items: true, refunds: { orderBy: { createdAt: "asc" } }, history: { orderBy: { createdAt: "asc" } } } });

ordersRouter.post("/:id/payment", requirePermission("payments.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.discriminatedUnion("action", [
    z.object({ action: z.literal("confirm") }),
    z.object({ action: z.literal("reject"), reason: z.string().trim().min(3, "Tell the guest why (at least 3 characters)").max(200) }),
    // Payment taken at the table or counter (cash, card machine, MoMo in person) for orders that didn't need proof.
    z.object({ action: z.literal("record"), method: METHOD }),
  ]), req.body);
  const { tenantId, user } = req.auth;
  const o = await prisma.order.findFirst({ where: { id: req.params.id, tenantId } });
  if (!o) throw notFound("Order not found.");
  if (o.status === "CANCELLED") throw conflict("This order was cancelled.");
  const now = new Date();
  const from = b.action === "record" ? "NOT_REQUIRED" : "PROOF_SUBMITTED";
  const data = b.action === "confirm" ? { paymentStatus: "CONFIRMED", paymentNote: null, paymentMethod: "MOBILE_MONEY", paidAt: now }
    : b.action === "record" ? { paymentStatus: "CONFIRMED", paymentMethod: b.method, paidAt: now }
    : { paymentStatus: "REJECTED", paymentNote: b.reason };
  const claim = await prisma.order.updateMany({ where: { id: o.id, tenantId, paymentStatus: from }, data: { ...data, paymentReviewedBy: user.id, paymentReviewedAt: now } });
  if (claim.count === 0) throw conflict(b.action === "record" ? "This order's payment is already recorded or is waiting on a proof check." : "This payment has already been reviewed.");
  const label = { MOBILE_MONEY: "Mobile Money", CASH: "cash", CARD: "card", OTHER: "other" };
  await audit(req, {
    action: b.action === "reject" ? "payment.rejected" : "payment.confirmed", entityType: "order", entityId: o.id,
    summary: b.action === "confirm" ? `Confirmed payment for order #${o.number} (RWF ${o.totalRwf})` : b.action === "record" ? `Recorded ${label[b.method]} payment for order #${o.number} (RWF ${o.totalRwf})` : `Rejected payment proof for order #${o.number}: ${b.reason}`,
  });
  if (b.action !== "reject") await awardLoyalty(o, req.auth.tenant);
  const fresh = await full(o.id, tenantId);
  emit(fresh);
  return ok(res, orderView(fresh), b.action === "reject" ? "Payment rejected. The guest can send a new proof." : b.action === "record" ? "Payment recorded." : "Payment confirmed.");
}));

// Refunds are a record of money handed back outside the app. Amount can never exceed what was paid.
ordersRouter.post("/:id/refund", requirePermission("payments.refund"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    amountRwf: z.number({ required_error: "Enter the refund amount", invalid_type_error: "Enter the refund amount" }).int("Use whole francs").min(1, "Refund at least 1 RWF"),
    reason: z.string().trim().min(3, "Give a reason (at least 3 characters)").max(200),
    method: METHOD,
  }), req.body);
  const { tenantId, user } = req.auth;
  const o = await prisma.order.findFirst({ where: { id: req.params.id, tenantId } });
  if (!o) throw notFound("Order not found.");
  if (o.paymentStatus !== "CONFIRMED") throw conflict("Only orders with a confirmed payment can be refunded.");
  const remaining = o.totalRwf - o.refundedRwf;
  if (b.amountRwf > remaining) throw conflict(`You can refund at most RWF ${remaining.toLocaleString("en-US")} on this order.`);
  // One atomic, guarded statement: the increment only happens while refunded + amount <= total,
  // so concurrent refunds can never add up to more than was paid (no interactive transaction needed).
  const claim = await prisma.order.updateMany({ where: { id: o.id, tenantId, refundedRwf: { lte: o.totalRwf - b.amountRwf } }, data: { refundedRwf: { increment: b.amountRwf } } });
  if (claim.count === 0) throw conflict("This order was just refunded by someone else. Refresh to see how much is left.");
  try {
    await prisma.refund.create({ data: { tenantId, orderId: o.id, amountRwf: b.amountRwf, reason: b.reason, method: b.method, actorId: user.id, actorName: user.fullName } });
  } catch (e) {
    await prisma.order.updateMany({ where: { id: o.id, tenantId }, data: { refundedRwf: { decrement: b.amountRwf } } }); // undo the claim
    throw e;
  }
  await reverseLoyalty(o, b.amountRwf, req.auth.tenant);
  await audit(req, { action: "payment.refunded", entityType: "order", entityId: o.id, summary: `Refunded RWF ${b.amountRwf} on order #${o.number}: ${b.reason}` });
  const fresh = await full(o.id, tenantId);
  emit(fresh);
  return ok(res, orderView(fresh), "Refund recorded.");
}));

ordersRouter.get("/:id/receipt", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const { tenantId, tenant } = req.auth;
  const o = await full(req.params.id, tenantId);
  if (!o) throw notFound("Order not found.");
  if (o.paymentStatus !== "CONFIRMED") throw conflict("A receipt is issued once the payment is confirmed or recorded.");
  return ok(res, receiptView(o, tenant, logoUrl(tenant)));
}));

ordersRouter.patch("/:id/status", requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(["PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED"]),
    reason: z.string().trim().max(200).optional(),
  }), req.body);
  const fresh = await transition(req, req.params.id, b.status, { reason: b.reason });
  return ok(res, orderView(fresh), "Order updated.");
}));

export { paymentOk };
