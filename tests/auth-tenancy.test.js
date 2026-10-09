import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";

let t;
before(async () => { t = await bootstrap("auth"); });
after(async () => { await t.close(); });

test("register creates a business, owner, starter roles and a 7-day trial", async () => {
  const r = await t.registerBusiness({ businessName: "Kigali Coffee Lab", planCode: "yearly" });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.tenant.slug, "kigali-coffee-lab");
  assert.equal(r.data.user.role.isOwner, true);
  const sub = r.data.user.subscription;
  assert.equal(sub.status, "TRIALING");
  assert.equal(sub.plan.code, "yearly");
  assert.equal(sub.trialDaysLeft, 7);
  assert.equal(sub.nextPayment.amountRwf, 180);

  const roles = await t.call("GET", "/roles", { token: r.token });
  assert.deepEqual(roles.data.map((x) => x.name).sort(), ["Barista", "Cashier", "Inventory Manager", "Kitchen", "Manager", "Owner", "Waiter"]);
});

test("validation: weak password, bad email, missing terms are rejected with a clear message", async () => {
  assert.equal((await t.registerBusiness({ password: "short" })).status, 400);
  assert.equal((await t.registerBusiness({ password: "nodigitshere" })).status, 400);
  assert.equal((await t.registerBusiness({ email: "not-an-email" })).status, 400);
  const noTerms = await t.registerBusiness({ acceptTerms: false });
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.res.message, /billing terms/i);
  assert.equal((await t.registerBusiness({ planCode: "lifetime" })).status, 400);
});

test("duplicate email and duplicate/reserved slug are refused", async () => {
  const a = await t.registerBusiness({ slug: "my-shop" });
  assert.equal(a.status, 201);
  assert.equal((await t.registerBusiness({ email: a.body.email })).status, 409);
  assert.equal((await t.registerBusiness({ slug: "my-shop" })).status, 409);
  assert.equal((await t.registerBusiness({ slug: "admin" })).status, 409);
  const check = await t.call("GET", "/public/slug-check?slug=my-shop");
  assert.equal(check.data.available, false);
  assert.equal((await t.call("GET", "/public/slug-check?slug=brand-new-slug")).data.available, true);
});

test("login works, wrong password fails, /me needs a token", async () => {
  const a = await t.registerBusiness();
  const ok = await t.call("POST", "/auth/login", { body: { email: a.body.email, password: "Passw0rd1" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal((await t.call("POST", "/auth/login", { body: { email: a.body.email, password: "wrong-pass1" } })).status, 401);
  assert.equal((await t.call("GET", "/auth/me")).status, 401);
  assert.equal((await t.call("GET", "/auth/me", { token: "garbage" })).status, 401);
});

test("TENANT ISOLATION: business A can never read or change business B's data", async () => {
  const a = await t.registerBusiness();
  const b = await t.registerBusiness();
  const bRoles = (await t.call("GET", "/roles", { token: b.token })).data;
  const bStaff = (await t.call("GET", "/staff", { token: b.token })).data;

  // A's lists contain only A's rows
  const aRoles = (await t.call("GET", "/roles", { token: a.token })).data;
  const aIds = new Set(aRoles.map((r) => r.id));
  assert.ok(bRoles.every((r) => !aIds.has(r.id)));
  assert.equal((await t.call("GET", "/staff", { token: a.token })).data.length, 1);

  // Direct id access to B's resources is a 404 for A
  assert.equal((await t.call("GET", `/roles/${bRoles[1].id}`, { token: a.token })).status, 404);
  assert.equal((await t.call("PATCH", `/roles/${bRoles[1].id}`, { token: a.token, body: { permissions: [] } })).status, 404);
  assert.equal((await t.call("DELETE", `/roles/${bRoles[2].id}`, { token: a.token })).status, 404);
  assert.equal((await t.call("PATCH", `/staff/${bStaff[0].id}`, { token: a.token, body: { isActive: false } })).status, 404);

  // A can't smuggle B's role into an invitation, nor pass a tenantId in the body
  const inv = await t.call("POST", "/staff/invitations", { token: a.token, body: { email: "x@example.com", roleId: bRoles[1].id } });
  assert.equal(inv.status, 400);
  const roleA = await t.call("POST", "/roles", { token: a.token, body: { name: "Custom", permissions: ["orders.view"], tenantId: b.user.tenant.id } });
  assert.equal(roleA.status, 201);
  const bAfter = (await t.call("GET", "/roles", { token: b.token })).data;
  assert.ok(!bAfter.some((r) => r.name === "Custom"));

  // Audit log only shows own tenant
  const logs = (await t.call("GET", "/audit-logs", { token: a.token })).data.items;
  assert.ok(logs.every((l) => !/Test Cafe/.test(l.summary) || l.summary.includes(a.body.businessName)));
});

test("one free trial per phone number; a repeat claimant must pay first", async () => {
  const first = await t.registerBusiness({ phone: "0788555111" });
  assert.equal(first.data.trialGranted, true);
  const repeat = await t.registerBusiness({ phone: "+250 788 555 111" });
  assert.equal(repeat.status, 201);
  assert.equal(repeat.data.trialGranted, false);
  assert.equal(repeat.data.user.subscription.status, "EXPIRED");
  assert.equal(repeat.data.user.subscription.paymentRequired, true);
  const blocked = await t.call("POST", "/roles", { token: repeat.token, body: { name: "X", permissions: [] } });
  assert.equal(blocked.status, 402);
});

test("public storefront exposes only safe fields", async () => {
  const a = await t.registerBusiness({ businessName: "Public Cafe", slug: "public-cafe" });
  const r = await t.call("GET", "/public/restaurants/public-cafe");
  assert.equal(r.status, 200);
  assert.equal(r.data.name, "Public Cafe");
  assert.ok(typeof r.data.hours.open === "boolean");
  assert.equal(r.data.email, undefined);
  assert.equal(r.data.id, undefined);
  assert.equal((await t.call("GET", "/public/restaurants/does-not-exist")).status, 404);
  assert.equal((await t.call("GET", "/public/restaurants/admin")).status, 404);
  void a;
});

test("password change signs out other sessions", async () => {
  const a = await t.registerBusiness();
  const wrong = await t.call("POST", "/auth/change-password", { token: a.token, body: { currentPassword: "nope1234", newPassword: "NewPass123" } });
  assert.equal(wrong.status, 400);
  const ok = await t.call("POST", "/auth/change-password", { token: a.token, body: { currentPassword: "Passw0rd1", newPassword: "NewPass123" } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call("GET", "/auth/me", { token: a.token })).status, 401, "old token is revoked");
  assert.equal((await t.call("GET", "/auth/me", { token: ok.data.token })).status, 200);
});
