import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { ok } from "../../shared/http.js";
import { asyncHandler, unauthorized } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission } from "../../shared/auth.js";
import * as svc from "./billing.service.js";

export const billingRouter = Router();
export const webhookRouter = Router();

const paymentView = (p) => ({
  id: p.id, txRef: p.txRef, planCode: p.planCode, amountRwf: p.amountRwf, currency: p.currency, status: p.status,
  method: p.method, failureReason: p.failureReason, periodStart: p.periodStart, periodEnd: p.periodEnd, createdAt: p.createdAt, paidAt: p.paidAt,
});

// Flutterwave -> us. Public, but authenticated by the shared secret hash.
// The payload is never trusted: we re-verify the transaction with Flutterwave.
webhookRouter.post("/flutterwave", asyncHandler(async (req, res) => {
  const sent = String(req.headers["verif-hash"] || "");
  const expected = env.flw.secretHash;
  const same = expected && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!same) throw unauthorized("Invalid webhook signature.");

  const event = req.body?.event || req.body?.["event.type"] || "unknown";
  const data = req.body?.data || {};
  const key = `flutterwave:${data.id ?? data.tx_ref ?? "none"}:${event}`;

  let record;
  try {
    record = await prisma.webhookEvent.create({ data: { provider: "flutterwave", eventKey: key, payload: JSON.stringify(req.body).slice(0, 20000) } });
  } catch (e) {
    if (e.code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({ where: { eventKey: key } });
      if (existing?.processedAt) return ok(res, { duplicate: true }, "Already processed.");
      record = existing; // seen but not finished: safe to retry — applying a payment is idempotent
    } else throw e;
  }

  if (event === "charge.completed" && (data.id || data.tx_ref)) {
    await svc.confirmPayment({ transactionId: data.id, txRef: data.tx_ref });
  }
  await prisma.webhookEvent.update({ where: { id: record.id }, data: { processedAt: new Date() } });
  return ok(res, { received: true }, "Received.");
}));

billingRouter.use(authenticate);

// Billing stays reachable after the trial ends so the owner can always pay.
billingRouter.get("/subscription", requirePermission("billing.view"), asyncHandler(async (req, res) => {
  return ok(res, await svc.getSubscriptionView(req.auth.tenantId));
}));

billingRouter.get("/payments", requirePermission("billing.view"), asyncHandler(async (req, res) => {
  const list = await prisma.billingPayment.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { createdAt: "desc" }, take: 50 });
  return ok(res, list.map(paymentView));
}));

billingRouter.post("/plan", requirePermission("billing.manage"), asyncHandler(async (req, res) => {
  const { planCode } = parse(z.object({ planCode: z.string().min(1) }), req.body);
  return ok(res, await svc.changePlan(req, planCode), "Plan selected.");
}));

billingRouter.post("/checkout", requirePermission("billing.manage"), asyncHandler(async (req, res) => {
  const { planCode } = parse(z.object({ planCode: z.string().min(1, "Choose a plan") }), req.body);
  return ok(res, await svc.startCheckout(req, planCode), "Checkout ready.");
}));

// The browser returns here from Flutterwave (?status=&tx_ref=&transaction_id=).
billingRouter.get("/verify", requirePermission("billing.manage"), asyncHandler(async (req, res) => {
  const q = parse(z.object({
    status: z.string().optional(), tx_ref: z.string().optional(), transaction_id: z.string().optional(),
  }), req.query);
  const { tenantId } = req.auth;

  if (q.status === "cancelled" && q.tx_ref) {
    await prisma.billingPayment.updateMany({ where: { txRef: q.tx_ref, tenantId, status: "PENDING" }, data: { status: "FAILED", failureReason: "Cancelled before payment" } });
    const payment = await prisma.billingPayment.findFirst({ where: { txRef: q.tx_ref, tenantId } });
    return ok(res, { result: "cancelled", payment: payment && paymentView(payment), subscription: await svc.getSubscriptionView(tenantId) });
  }

  const outcome = await svc.confirmPayment({ transactionId: q.transaction_id, txRef: q.tx_ref, tenantId, req });
  const result = outcome.failed ? "failed" : "successful";
  return ok(res, { result, reason: outcome.reason, alreadyApplied: !!outcome.alreadyApplied, payment: paymentView(outcome.payment), subscription: await svc.getSubscriptionView(tenantId) });
}));

billingRouter.post("/cancel", requirePermission("billing.manage"), asyncHandler(async (req, res) => {
  return ok(res, await svc.cancelSubscription(req), "Subscription canceled. We won't ask you to pay.");
}));

billingRouter.post("/resume", requirePermission("billing.manage"), asyncHandler(async (req, res) => {
  return ok(res, await svc.resumeSubscription(req), "Subscription resumed.");
}));
