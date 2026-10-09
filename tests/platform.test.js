import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { bootstrap } from "./helpers.js";

let t, admin, support, owners = {};
const DAY = 86_400_000;
const adminCall = (method, path, opts = {}) => t.call(method, `/admin${path}`, { token: admin, ...opts });

before(async () => {
  t = await bootstrap("platform");
  const mk = async (email, role) => { await t.prisma.platformUser.create({ data: { email, fullName: `${role} Person`, role, passwordHash: await bcrypt.hash("a-very-long-passphrase", 4) } }); return (await t.call("POST", "/admin/login", { body: { email, password: "a-very-long-passphrase" } })).data.token; };
  admin = await mk("boss@platform.rw", "SUPER_ADMIN"); support = await mk("help@platform.rw", "SUPPORT");
});
after(async () => { await t.close(); });

test("platform login: separate accounts, wrong passwords and inactive users refused; tokens can't cross over", async () => {
  assert.equal((await t.call("POST", "/admin/login", { body: { email: "boss@platform.rw", password: "wrong" } })).status, 401);
  assert.equal((await t.call("POST", "/admin/login", { body: { email: "nobody@platform.rw", password: "a-very-long-passphrase" } })).status, 401);
  await t.prisma.platformUser.create({ data: { email: "off@platform.rw", fullName: "Off", role: "SUPPORT", isActive: false, passwordHash: await bcrypt.hash("a-very-long-passphrase", 4) } });
  assert.equal((await t.call("POST", "/admin/login", { body: { email: "off@platform.rw", password: "a-very-long-passphrase" } })).status, 401);

  const owner = await t.registerBusiness({ businessName: "Crossover Cafe" });
  assert.equal((await t.call("GET", "/admin/overview", { token: owner.token })).status, 401, "a restaurant token is no admin token");
  assert.equal((await t.call("GET", "/billing/subscription", { token: admin })).status, 401, "an admin token is no restaurant token");
  assert.equal((await t.call("GET", "/dashboard/summary", { token: admin })).status, 401);
  assert.equal((await t.call("GET", "/admin/overview")).status, 401);
  assert.equal((await t.call("GET", "/admin/me", { token: admin })).data.role, "SUPER_ADMIN");

  // disabling an account or bumping its token version signs it out immediately
  const u = await t.prisma.platformUser.findUnique({ where: { email: "help@platform.rw" } });
  await t.prisma.platformUser.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
  assert.equal((await t.call("GET", "/admin/me", { token: support })).status, 401);
  support = (await t.call("POST", "/admin/login", { body: { email: "help@platform.rw", password: "a-very-long-passphrase" } })).data.token;
});

test("overview and business list: states, revenue, MRR, health flags, filters and paging", async () => {
  const mk = async (name) => { const r = await t.registerBusiness({ businessName: name }); owners[name] = r; return r; };
  const trial = await mk("Trial Cafe"), paying = await mk("Paying Cafe"), yearly = await mk("Yearly Cafe"), expired = await mk("Expired Cafe"), sleepy = await mk("Sleepy Cafe");
  const tid = (o) => o.user.tenant.id;
  const now = Date.now();
  await t.prisma.subscription.update({ where: { tenantId: tid(paying) }, data: { planCode: "monthly", currentPeriodEnd: new Date(now + 30 * DAY), trialEndsAt: new Date(now - DAY) } });
  await t.prisma.subscription.update({ where: { tenantId: tid(yearly) }, data: { planCode: "yearly", currentPeriodEnd: new Date(now + 300 * DAY), trialEndsAt: new Date(now - DAY) } });
  await t.prisma.subscription.update({ where: { tenantId: tid(expired) }, data: { trialEndsAt: new Date(now - 5 * DAY), currentPeriodEnd: null } });
  await t.prisma.user.updateMany({ where: { tenantId: tid(sleepy) }, data: { lastLoginAt: new Date(now - 30 * DAY) } });
  await t.prisma.billingPayment.create({ data: { tenantId: tid(paying), planCode: "monthly", amountRwf: 20, txRef: "tx-1", status: "SUCCESSFUL", paidAt: new Date(now - DAY), initiatedById: "x" } });
  await t.prisma.billingPayment.create({ data: { tenantId: tid(yearly), planCode: "yearly", amountRwf: 180, txRef: "tx-2", status: "SUCCESSFUL", paidAt: new Date(now - 40 * DAY), initiatedById: "x" } }); // outside 30 days
  await t.prisma.billingPayment.create({ data: { tenantId: tid(trial), planCode: "monthly", amountRwf: 20, txRef: "tx-3", status: "FAILED", initiatedById: "x", failureReason: "Declined" } });
  const branch = await t.prisma.branch.findFirst({ where: { tenantId: tid(paying) } });
  await t.prisma.order.create({ data: { tenantId: tid(paying), branchId: branch.id, number: 1001, publicToken: crypto.randomBytes(8).toString("hex"), customerName: "G", status: "COMPLETED", paymentStatus: "CONFIRMED", paidAt: new Date(), totalRwf: 5000, subtotalRwf: 5000, proofRequired: false } });
  await t.prisma.order.create({ data: { tenantId: tid(paying), branchId: branch.id, number: 1002, publicToken: crypto.randomBytes(8).toString("hex"), customerName: "G", status: "PLACED", paymentStatus: "PROOF_SUBMITTED", totalRwf: 999, subtotalRwf: 999, proofRequired: true } });

  const o = (await adminCall("GET", "/overview")).data;
  // 5 businesses are registered in this file plus "Crossover Cafe" from the first test
  assert.deepEqual(o.tenants, { total: 6, paying: 2, trialing: 3, expired: 1, suspended: 0 }, JSON.stringify(o.tenants));
  assert.equal(o.mrrRwf, Math.round(20 / 1 + 180 / 12), "monthly price + yearly price spread over 12 months");
  assert.equal(o.revenue30dRwf, 20, "only successful payments in the last 30 days"); assert.equal(o.payments30d, 1);
  assert.equal(o.platformSales30dRwf, 5000, "unpaid orders are not sales"); assert.equal(o.paidOrders30d, 1); assert.equal(o.orders30d, 2);
  assert.equal(o.signups30d, 6);
  assert.ok(o.health.noSignIn21d >= 1);

  const all = (await adminCall("GET", "/tenants")).data;
  assert.equal(all.total, 6); assert.deepEqual([all.counts.all, all.counts.paying, all.counts.trialing, all.counts.expired], [6, 2, 3, 1]);
  assert.equal((await adminCall("GET", "/tenants?state=expired")).data.items[0].name, "Expired Cafe");
  assert.equal((await adminCall("GET", "/tenants?search=yearly")).data.items.length, 1);
  assert.equal((await adminCall("GET", `/tenants?search=${encodeURIComponent(paying.user.email)}`)).data.items[0].name, "Paying Cafe", "search by owner email");
  const flagged = (await adminCall("GET", "/tenants?flagged=1")).data.items;
  assert.ok(flagged.find((x) => x.name === "Sleepy Cafe").flags.includes("No sign-in for 21+ days"));
  assert.ok(flagged.find((x) => x.name === "Trial Cafe").flags.includes("No orders in 7 days"));
  assert.equal((await adminCall("GET", "/tenants?pageSize=5&page=2")).data.items.length, 1);

  const d = (await adminCall("GET", `/tenants/${tid(paying)}`)).data;
  assert.equal(d.owner.email, paying.user.email); assert.equal(d.state, "paying"); assert.equal(d.payments.length, 1); assert.equal(d.staffCount, 1);
  assert.equal((await adminCall("GET", "/tenants/nope")).status, 404);
  assert.equal((await adminCall("GET", "/tenants", { token: support })).status, 200, "support can read");
});

test("suspend blocks staff, sign-in and guests at once; reinstating restores; the business sees what happened", async () => {
  const owner = await t.registerBusiness({ businessName: "Naughty Cafe" }); const id = owner.user.tenant.id;
  const cat = (await t.call("POST", "/menu/categories", { token: owner.token, body: { name: "Drinks" } })).data;
  await t.call("POST", "/menu/products", { token: owner.token, body: { categoryId: cat.id, name: "Tea", priceRwf: 500 } });
  const qr = (await t.call("POST", "/tables", { token: owner.token, body: { count: 1 } })).data[0].qrToken;
  assert.equal((await t.call("GET", `/public/q/${qr}`)).status, 200);

  assert.equal((await adminCall("POST", `/tenants/${id}/suspend`, { body: {} })).status, 400, "a reason is required");
  assert.equal((await adminCall("POST", `/tenants/${id}/suspend`, { token: support, body: { reason: "Chargeback dispute" } })).status, 403, "support is read-only");
  assert.equal((await adminCall("POST", `/tenants/${id}/suspend`, { body: { reason: "Chargeback dispute" } })).status, 200);
  assert.equal((await adminCall("POST", `/tenants/${id}/suspend`, { body: { reason: "Again please" } })).status, 409);

  assert.equal((await t.call("GET", "/dashboard/summary", { token: owner.token })).status, 403, "existing sessions are cut off immediately");
  assert.equal((await t.call("POST", "/auth/login", { body: { email: owner.user.email, password: "Password123" } })).status, 401);
  assert.equal((await t.call("GET", `/public/q/${qr}`)).status, 404, "guests can't order from a suspended business");
  const row = (await adminCall("GET", `/tenants/${id}`)).data; assert.equal(row.state, "suspended"); assert.equal(row.suspendedReason, "Chargeback dispute");
  assert.equal((await adminCall("GET", "/tenants?state=suspended")).data.total, 1);

  assert.equal((await adminCall("POST", `/tenants/${id}/unsuspend`, {})).status, 200);
  assert.equal((await adminCall("POST", `/tenants/${id}/unsuspend`, {})).status, 409);
  assert.equal((await t.call("GET", "/dashboard/summary", { token: owner.token })).status, 200);
  assert.equal((await t.call("GET", `/public/q/${qr}`)).status, 200);
  const log = (await t.call("GET", "/audit-logs?pageSize=20", { token: owner.token })).data.items;
  assert.ok(log.some((l) => /Account suspended: Chargeback dispute/.test(l.summary) && /RestaurantOS support/.test(l.actorName)), "the business can see the platform's actions");
  assert.ok(log.some((l) => /Account reinstated/.test(l.summary)));
  const ev = (await adminCall("GET", "/events")).data.map((e) => e.summary).join("\n");
  assert.match(ev, /Suspended "Naughty Cafe": Chargeback dispute/); assert.match(ev, /Reinstated "Naughty Cafe"/);
  assert.equal((await adminCall("POST", "/tenants/nope/suspend", { body: { reason: "Testing" } })).status, 404);
});

test("extending access: trials, expired businesses and prepaid periods each get the right days", async () => {
  const get = async (o) => t.prisma.subscription.findUnique({ where: { tenantId: o.user.tenant.id } });
  const ext = (o, body, tk = admin) => t.call("POST", `/admin/tenants/${o.user.tenant.id}/extend`, { token: tk, body });
  const a = await t.registerBusiness({ businessName: "Extend A" });
  const before = await get(a);
  assert.equal((await ext(a, { days: 7, reason: "Welcome gift" })).status, 200);
  assert.equal((await get(a)).trialEndsAt.getTime() - before.trialEndsAt.getTime(), 7 * DAY, "a running trial just gets longer");

  const b = await t.registerBusiness({ businessName: "Extend B" });
  await t.prisma.subscription.update({ where: { tenantId: b.user.tenant.id }, data: { trialEndsAt: new Date(Date.now() - 10 * DAY) } });
  assert.equal((await t.call("PATCH", "/tenant", { token: b.token, body: {} })).status, 402, "expired: writes blocked");
  await ext(b, { days: 3, reason: "Outage compensation" });
  const after = await get(b); const left = (after.trialEndsAt.getTime() - Date.now()) / DAY;
  assert.ok(left > 2.9 && left <= 3.01, `3 days counted from now, not from the long-gone end date (${left})`);
  assert.notEqual((await t.call("PATCH", "/tenant", { token: b.token, body: {} })).status, 402, "access is back");

  const c = await t.registerBusiness({ businessName: "Extend C" });
  const end = new Date(Date.now() + 20 * DAY);
  await t.prisma.subscription.update({ where: { tenantId: c.user.tenant.id }, data: { currentPeriodEnd: end, trialEndsAt: new Date(Date.now() - DAY) } });
  await ext(c, { days: 10, reason: "Goodwill" });
  assert.equal((await get(c)).currentPeriodEnd.getTime() - end.getTime(), 10 * DAY, "a paid period is extended at its end");

  for (const bad of [{ days: 0, reason: "okay" }, { days: 366, reason: "okay" }, { days: 1.5, reason: "okay" }, { days: 5, reason: "x" }, { reason: "okay" }]) assert.equal((await ext(a, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await ext(a, { days: 5, reason: "Okay then" }, support)).status, 403);
  const log = (await t.call("GET", "/audit-logs?pageSize=10", { token: a.token })).data.items.map((l) => l.summary).join("\n");
  assert.match(log, /Access extended by 7 days: Welcome gift/);
});

test("plans: prices can be changed, apply to future payments only, show publicly; safeguards hold", async () => {
  const plans = (await adminCall("GET", "/plans")).data;
  assert.deepEqual(plans.map((p) => p.code), ["monthly", "quarterly", "semiannual", "yearly"]);
  const month = plans.find((p) => p.code === "monthly");
  assert.ok(month.businesses >= 1);

  const owner = await t.registerBusiness({ businessName: "Price Cafe" });
  await t.call("POST", "/billing/checkout", { token: owner.token, body: { planCode: "monthly" } });
  assert.equal(t.mock.state.payments.at(-1).amount, 20);
  const old = await t.prisma.billingPayment.findFirst({ where: { tenantId: owner.user.tenant.id } });

  for (const bad of [{ priceRwf: 0 }, { priceRwf: -5 }, { priceRwf: 12.5 }, { priceRwf: 99999999 }, { name: "x" }]) assert.equal((await adminCall("PATCH", "/plans/monthly", { body: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await adminCall("PATCH", "/plans/monthly", { token: support, body: { priceRwf: 5000 } })).status, 403);
  assert.equal((await adminCall("PATCH", "/plans/nope", { body: { priceRwf: 5000 } })).status, 404);
  const up = await adminCall("PATCH", "/plans/monthly", { body: { priceRwf: 5000 } });
  assert.equal(up.status, 200); assert.equal(up.data.priceRwf, 5000);
  assert.equal((await t.call("GET", "/public/plans")).data.plans.find((p) => p.code === "monthly").priceRwf, 5000, "the pricing page follows");
  assert.equal((await t.call("GET", "/billing/subscription", { token: owner.token })).data.nextPayment.amountRwf, 5000);

  await t.call("POST", "/billing/checkout", { token: owner.token, body: { planCode: "monthly" } });
  assert.equal(t.mock.state.payments.at(-1).amount, 5000, "new checkouts charge the new price");
  assert.equal((await t.prisma.billingPayment.findUnique({ where: { id: old.id } })).amountRwf, 20, "recorded payments never change");

  // deactivating hides a plan from the public list; the last active plan can't be switched off
  assert.equal((await adminCall("PATCH", "/plans/yearly", { body: { active: false } })).status, 200);
  assert.equal((await t.call("GET", "/public/plans")).data.plans.some((p) => p.code === "yearly"), false);
  for (const c of ["quarterly", "semiannual"]) await adminCall("PATCH", `/plans/${c}`, { body: { active: false } });
  assert.equal((await adminCall("PATCH", "/plans/monthly", { body: { active: false } })).status, 400, "at least one plan must stay active");
  for (const c of ["yearly", "quarterly", "semiannual"]) await adminCall("PATCH", `/plans/${c}`, { body: { active: true } });
  await adminCall("PATCH", "/plans/monthly", { body: { priceRwf: 20 } });
  assert.match((await adminCall("GET", "/events")).data.map((e) => e.summary).join("\n"), /Plan "Monthly": price RWF 20 → 5000/);
});

test("platform payments list: paging, status filter, business names", async () => {
  const all = (await adminCall("GET", "/payments")).data;
  assert.ok(all.total >= 3); assert.ok(all.items.every((p) => p.business));
  const ok = (await adminCall("GET", "/payments?status=SUCCESSFUL")).data; assert.ok(ok.items.every((p) => p.status === "SUCCESSFUL")); assert.ok(ok.total >= 2);
  assert.equal((await adminCall("GET", "/payments?status=FAILED")).data.items[0].failureReason, "Declined");
  assert.equal((await adminCall("GET", "/payments?pageSize=5&page=1")).data.items.length, 5);
});
