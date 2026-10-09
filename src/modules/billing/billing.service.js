import crypto from "node:crypto";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { audit } from "../../shared/audit.js";
import { badRequest, notFound } from "../../shared/errors.js";
import { addMonths, hasAccess, nextPeriodStart, buildSubscriptionView } from "./subscription.js";
import { listPlans } from "./plans.js";
import * as flutterwave from "./flutterwave.js";

export async function getSubscriptionView(tenantId) {
  const [sub, plans] = await Promise.all([prisma.subscription.findUnique({ where: { tenantId } }), listPlans()]);
  if (!sub) throw notFound("No subscription found for this business.");
  return buildSubscriptionView(sub, plans);
}

export async function startCheckout(req, planCode) {
  const { tenantId, user } = req.auth;
  const plan = await prisma.plan.findFirst({ where: { code: planCode, active: true } });
  if (!plan) throw badRequest("Choose one of the available plans.");
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

  const txRef = `ROS-${tenantId.slice(-6)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  await prisma.billingPayment.create({
    data: { tenantId, planCode: plan.code, amountRwf: plan.priceRwf, currency: "RWF", txRef, initiatedById: user.id },
  });

  const link = await flutterwave.createCheckout({
    txRef,
    amount: plan.priceRwf,
    currency: "RWF",
    redirectUrl: `${env.clientUrl}/app/billing/result`,
    customer: { email: user.email, name: user.fullName, phonenumber: tenant.phone },
    title: "RestaurantOS subscription",
    description: `${plan.name} plan for ${tenant.name}`,
    meta: { tenantId, planCode: plan.code },
  }).catch(async (e) => {
    await prisma.billingPayment.update({ where: { txRef }, data: { status: "FAILED", failureReason: e.message } });
    throw e;
  });

  await prisma.subscription.update({ where: { tenantId }, data: { planCode: plan.code } });
  await audit(req, { action: "billing.checkout_started", entityType: "payment", entityId: txRef, summary: `Started checkout for the ${plan.name} plan (RWF ${plan.priceRwf})` });
  return { link, txRef };
}

/**
 * Confirm a Flutterwave transaction with the provider (never trust the redirect
 * query string or webhook body on their own), then extend the subscription —
 * exactly once, however many times this is called (redirect + webhook + refresh).
 */
export async function confirmPayment({ transactionId, txRef, tenantId, req }) {
  let data;
  if (transactionId) data = await flutterwave.verifyTransaction(transactionId);
  else if (txRef) data = await flutterwave.verifyByReference(txRef);
  else throw badRequest("Missing transaction reference.");

  const ref = data?.tx_ref || txRef;
  const payment = await prisma.billingPayment.findUnique({ where: { txRef: ref } });
  if (!payment) throw notFound("We couldn't match this payment to an order.");
  if (tenantId && payment.tenantId !== tenantId) throw notFound("We couldn't match this payment to an order.");

  if (payment.status === "SUCCESSFUL") return { payment, alreadyApplied: true };

  const successful = data?.status === "successful";
  const amountOk = Number(data?.amount) >= payment.amountRwf;
  const currencyOk = String(data?.currency || "").toUpperCase() === payment.currency;

  if (!successful || !amountOk || !currencyOk) {
    const reason = !successful
      ? `Provider status: ${data?.status || "unknown"}`
      : !amountOk ? "Amount paid is lower than the plan price" : "Currency mismatch";
    // A "pending" provider status can still complete later, so don't mark it failed.
    if (data?.status !== "pending") {
      await prisma.billingPayment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", failureReason: reason, providerTxId: data?.id ? String(data.id) : null } });
    }
    return { payment: await prisma.billingPayment.findUnique({ where: { id: payment.id } }), alreadyApplied: false, failed: true, reason };
  }

  const plan = await prisma.plan.findFirst({ where: { code: payment.planCode } });
  const applied = await prisma.$transaction(async (tx) => {
    // Atomic claim: only the first caller flips PENDING/FAILED -> SUCCESSFUL.
    const claim = await tx.billingPayment.updateMany({
      where: { id: payment.id, status: { not: "SUCCESSFUL" } },
      data: { status: "SUCCESSFUL", paidAt: new Date(), providerTxId: String(data.id), method: data.payment_type || null, failureReason: null },
    });
    if (claim.count === 0) return false;

    const sub = await tx.subscription.findUnique({ where: { tenantId: payment.tenantId } });
    const now = new Date();
    const periodStart = nextPeriodStart(sub, now);
    const periodEnd = addMonths(periodStart, plan.months);
    await tx.subscription.update({
      where: { tenantId: payment.tenantId },
      data: { planCode: plan.code, currentPeriodEnd: periodEnd, canceledAt: null },
    });
    await tx.billingPayment.update({ where: { id: payment.id }, data: { periodStart, periodEnd } });
    return true;
  });

  const fresh = await prisma.billingPayment.findUnique({ where: { id: payment.id } });
  if (applied) {
    await audit(req, {
      tenantId: payment.tenantId, actor: req?.auth?.user,
      action: "billing.payment_succeeded", entityType: "payment", entityId: payment.txRef,
      summary: `Payment of RWF ${payment.amountRwf} received for the ${plan.name} plan`,
    });
  }
  return { payment: fresh, alreadyApplied: !applied };
}

export async function cancelSubscription(req) {
  const { tenantId } = req.auth;
  await prisma.subscription.update({ where: { tenantId }, data: { canceledAt: new Date() } });
  await audit(req, { action: "billing.canceled", entityType: "subscription", summary: "Canceled the subscription — no payment will be requested" });
  return getSubscriptionView(tenantId);
}

export async function resumeSubscription(req) {
  const { tenantId } = req.auth;
  await prisma.subscription.update({ where: { tenantId }, data: { canceledAt: null } });
  await audit(req, { action: "billing.resumed", entityType: "subscription", summary: "Resumed the subscription" });
  return getSubscriptionView(tenantId);
}

export async function changePlan(req, planCode) {
  const { tenantId } = req.auth;
  const plan = await prisma.plan.findFirst({ where: { code: planCode, active: true } });
  if (!plan) throw badRequest("Choose one of the available plans.");
  await prisma.subscription.update({ where: { tenantId }, data: { planCode: plan.code } });
  await audit(req, { action: "billing.plan_selected", entityType: "subscription", summary: `Selected the ${plan.name} plan` });
  return getSubscriptionView(tenantId);
}

export { hasAccess };
