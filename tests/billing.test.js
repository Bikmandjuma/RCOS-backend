import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";
import { addMonths, buildSubscriptionView, nextPeriodStart, withSavings } from "../src/modules/billing/subscription.js";

let t;
before(async () => { t = await bootstrap("billing"); });
after(async () => { await t.close(); });

const DAY = 86400000;
const plans = [
  { code: "monthly", name: "Monthly", months: 1, priceRwf: 20 },
  { code: "quarterly", name: "3 Months", months: 3, priceRwf: 55 },
  { code: "semiannual", name: "6 Months", months: 6, priceRwf: 100 },
  { code: "yearly", name: "Yearly", months: 12, priceRwf: 180 },
];

test("pure rules: savings match the published pricing", () => {
  const s = Object.fromEntries(withSavings(plans).map((p) => [p.code, p]));
  assert.equal(s.quarterly.saveRwf, 5); assert.equal(s.quarterly.savePercent, 8.3);
  assert.equal(s.semiannual.saveRwf, 20); assert.equal(s.semiannual.savePercent, 16.7);
  assert.equal(s.yearly.saveRwf, 60); assert.equal(s.yearly.savePercent, 25);
  assert.equal(s.monthly.saveRwf, 0);
});

test("pure rules: addMonths clamps month ends", () => {
  assert.equal(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(addMonths(new Date("2026-03-15T00:00:00Z"), 12).toISOString().slice(0, 10), "2027-03-15");
});

test("pure rules: trial, reminder window, expiry, prepaid-during-trial", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const base = { planCode: "monthly", trialGranted: true, canceledAt: null, currentPeriodEnd: null };
  const mid = buildSubscriptionView({ ...base, trialEndsAt: new Date(now.getTime() + 5 * DAY) }, plans, now);
  assert.equal(mid.status, "TRIALING"); assert.equal(mid.reminder, false); assert.equal(mid.trialDaysLeft, 5);
  const close = buildSubscriptionView({ ...base, trialEndsAt: new Date(now.getTime() + 1.5 * DAY) }, plans, now);
  assert.equal(close.reminder, true); assert.equal(close.nextPayment.amountRwf, 20);
  const over = buildSubscriptionView({ ...base, trialEndsAt: new Date(now.getTime() - 1) }, plans, now);
  assert.equal(over.status, "EXPIRED"); assert.equal(over.paymentRequired, true); assert.equal(over.hasAccess, false);

  const sub = { ...base, trialEndsAt: new Date(now.getTime() + 3 * DAY) };
  assert.equal(nextPeriodStart(sub, now).getTime(), sub.trialEndsAt.getTime(), "paying in trial keeps the remaining trial days");
  const prepaid = buildSubscriptionView({ ...sub, currentPeriodEnd: addMonths(sub.trialEndsAt, 1) }, plans, now);
  assert.equal(prepaid.status, "TRIALING"); assert.equal(prepaid.prepaid, true); assert.equal(prepaid.hasAccess, true);

  const canceled = buildSubscriptionView({ ...sub, canceledAt: now }, plans, now);
  assert.equal(canceled.status, "CANCELED"); assert.equal(canceled.nextPayment, null); assert.equal(canceled.reminder, false);
});

test("public plans endpoint returns the four plans and trial length", async () => {
  const r = await t.call("GET", "/public/plans");
  assert.equal(r.data.trialDays, 7);
  assert.deepEqual(r.data.plans.map((p) => [p.code, p.priceRwf]), [["monthly", 20], ["quarterly", 55], ["semiannual", 100], ["yearly", 180]]);
});

async function pay(owner, planCode, txOverrides = {}) {
  const co = await t.call("POST", "/billing/checkout", { token: owner.token, body: { planCode } });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const price = { monthly: 20, quarterly: 55, semiannual: 100, yearly: 180 }[planCode];
  const id = String(Math.floor(Math.random() * 1e9));
  t.mock.state.transactions[id] = { id: Number(id), tx_ref: co.data.txRef, status: "successful", amount: price, currency: "RWF", payment_type: "mobilemoneyrwanda", ...txOverrides };
  return { ...co.data, id };
}

test("checkout: creates a pending payment and a hosted link offering card + MoMo, in RWF", async () => {
  const owner = await t.registerBusiness();
  const { link, txRef } = await pay(owner, "quarterly");
  assert.match(link, /checkout\.flutterwave\.test\/pay\/ROS-/);
  const sent = t.mock.state.payments.at(-1);
  assert.equal(sent.amount, 55); assert.equal(sent.currency, "RWF");
  assert.equal(sent.payment_options, "card,mobilemoneyrwanda");
  assert.equal(sent.redirect_url, "http://localhost:5173/app/billing/result");
  assert.equal(sent.customer.email, owner.body.email);
  const hist = (await t.call("GET", "/billing/payments", { token: owner.token })).data;
  assert.equal(hist[0].status, "PENDING"); assert.equal(hist[0].txRef, txRef);
});

test("verify: success extends access once — paying during trial keeps the trial days; replays are idempotent", async () => {
  const owner = await t.registerBusiness();
  const before = (await t.call("GET", "/billing/subscription", { token: owner.token })).data;
  const p = await pay(owner, "yearly");
  const v1 = await t.call("GET", `/billing/verify?status=successful&tx_ref=${p.txRef}&transaction_id=${p.id}`, { token: owner.token });
  assert.equal(v1.data.result, "successful");
  const sub = v1.data.subscription;
  assert.equal(sub.status, "TRIALING"); assert.equal(sub.prepaid, true);
  const expectedEnd = addMonths(new Date(before.trialEndsAt), 12).getTime();
  assert.equal(new Date(sub.currentPeriodEnd).getTime(), expectedEnd);

  const v2 = await t.call("GET", `/billing/verify?status=successful&tx_ref=${p.txRef}&transaction_id=${p.id}`, { token: owner.token });
  assert.equal(v2.data.alreadyApplied, true);
  assert.equal(new Date(v2.data.subscription.currentPeriodEnd).getTime(), expectedEnd, "no double extension");
  const hist = (await t.call("GET", "/billing/payments", { token: owner.token })).data;
  assert.equal(hist.filter((h) => h.status === "SUCCESSFUL").length, 1);
});

test("verify: underpayment, wrong currency, failed status and unknown ids are rejected", async () => {
  const owner = await t.registerBusiness();
  const under = await pay(owner, "yearly", { amount: 20 });
  const r1 = await t.call("GET", `/billing/verify?transaction_id=${under.id}&tx_ref=${under.txRef}`, { token: owner.token });
  assert.equal(r1.data.result, "failed"); assert.match(r1.data.reason, /lower than the plan price/);
  const cur = await pay(owner, "monthly", { currency: "USD" });
  assert.equal((await t.call("GET", `/billing/verify?transaction_id=${cur.id}`, { token: owner.token })).data.result, "failed");
  const bad = await pay(owner, "monthly", { status: "failed" });
  assert.equal((await t.call("GET", `/billing/verify?transaction_id=${bad.id}`, { token: owner.token })).data.result, "failed");
  const sub = (await t.call("GET", "/billing/subscription", { token: owner.token })).data;
  assert.equal(sub.prepaid, false, "nothing was granted");
  assert.equal((await t.call("GET", "/billing/verify?transaction_id=999999999", { token: owner.token })).status, 502);
});

test("verify: another business can't claim someone else's payment", async () => {
  const a = await t.registerBusiness();
  const b = await t.registerBusiness();
  const p = await pay(a, "monthly");
  const steal = await t.call("GET", `/billing/verify?transaction_id=${p.id}&tx_ref=${p.txRef}`, { token: b.token });
  assert.equal(steal.status, 404);
  const subA = (await t.call("GET", "/billing/subscription", { token: a.token })).data;
  assert.equal(subA.prepaid, false);
});

test("cancelled checkout is recorded without granting access", async () => {
  const owner = await t.registerBusiness();
  const p = await pay(owner, "monthly");
  const r = await t.call("GET", `/billing/verify?status=cancelled&tx_ref=${p.txRef}`, { token: owner.token });
  assert.equal(r.data.result, "cancelled");
  assert.equal(r.data.payment.status, "FAILED");
});

test("provider error on checkout marks the payment failed and returns a clear message", async () => {
  const owner = await t.registerBusiness();
  t.mock.state.failNext = true;
  const r = await t.call("POST", "/billing/checkout", { token: owner.token, body: { planCode: "monthly" } });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /Invalid currency/);
  assert.equal((await t.call("GET", "/billing/payments", { token: owner.token })).data[0].status, "FAILED");
});

test("webhook: rejects a bad signature; valid event applies once; duplicates are ignored", async () => {
  const owner = await t.registerBusiness();
  const p = await pay(owner, "semiannual");
  const event = { event: "charge.completed", data: { id: Number(p.id), tx_ref: p.txRef, status: "successful" } };

  assert.equal((await t.call("POST", "/webhooks/flutterwave", { body: event })).status, 401);
  assert.equal((await t.call("POST", "/webhooks/flutterwave", { body: event, headers: { "verif-hash": "wrong" } })).status, 401);

  const good = await t.call("POST", "/webhooks/flutterwave", { body: event, headers: { "verif-hash": "test-webhook-hash" } });
  assert.equal(good.status, 200);
  const sub1 = (await t.call("GET", "/billing/subscription", { token: owner.token })).data;
  assert.equal(sub1.prepaid, true);
  const dup = await t.call("POST", "/webhooks/flutterwave", { body: event, headers: { "verif-hash": "test-webhook-hash" } });
  assert.equal(dup.data.duplicate, true);
  const sub2 = (await t.call("GET", "/billing/subscription", { token: owner.token })).data;
  assert.equal(sub2.currentPeriodEnd, sub1.currentPeriodEnd);

  // A forged payload claiming success is useless: we re-verify with Flutterwave.
  const forged = await t.call("POST", "/webhooks/flutterwave", { body: { event: "charge.completed", data: { id: 424242, tx_ref: "ROS-fake", status: "successful" } }, headers: { "verif-hash": "test-webhook-hash" } });
  assert.notEqual(forged.status, 200);
});

test("expired subscription: writes return 402 but billing, session and reads still work; paying restores access", async () => {
  const owner = await t.registerBusiness();
  await t.prisma.subscription.update({ where: { tenantId: owner.user.tenant.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  const me = await t.call("GET", "/auth/me", { token: owner.token });
  assert.equal(me.data.subscription.status, "EXPIRED");
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  assert.equal((await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "late@example.com", roleId: roles[2].id } })).status, 402);
  assert.equal((await t.call("PATCH", "/tenant", { token: owner.token, body: {} })).status, 402, "writes are blocked before validation");
  assert.equal((await t.call("GET", "/billing/subscription", { token: owner.token })).status, 200);

  const p = await pay(owner, "monthly");
  const v = await t.call("GET", `/billing/verify?transaction_id=${p.id}&tx_ref=${p.txRef}`, { token: owner.token });
  assert.equal(v.data.subscription.status, "ACTIVE");
  const after = addMonths(new Date(), 1).getTime();
  assert.ok(Math.abs(new Date(v.data.subscription.currentPeriodEnd).getTime() - after) < 60_000, "paid period starts now when expired");
  assert.equal((await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "late@example.com", roleId: roles[2].id } })).status, 201);
});

test("cancel and resume; only users with billing.manage can change billing", async () => {
  const owner = await t.registerBusiness();
  const c = await t.call("POST", "/billing/cancel", { token: owner.token });
  assert.equal(c.data.status, "CANCELED"); assert.equal(c.data.nextPayment, null); assert.equal(c.data.hasAccess, true);
  const r = await t.call("POST", "/billing/resume", { token: owner.token });
  assert.equal(r.data.status, "TRIALING");
  const sw = await t.call("POST", "/billing/plan", { token: owner.token, body: { planCode: "yearly" } });
  assert.equal(sw.data.nextPayment.amountRwf, 180);

  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const inv = await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "mgr@example.com", roleId: roles.find((x) => x.name === "Manager").id } });
  const acc = await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: "Mgr", password: "Mgrpass123" } });
  assert.equal((await t.call("POST", "/billing/cancel", { token: acc.data.token })).status, 403);
  assert.equal((await t.call("POST", "/billing/checkout", { token: acc.data.token, body: { planCode: "monthly" } })).status, 403);
});
