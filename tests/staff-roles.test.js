import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";

let t;
before(async () => { t = await bootstrap("staff"); });
after(async () => { await t.close(); });

async function inviteAndAccept(owner, roleName, email) {
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const role = roles.find((r) => r.name === roleName);
  const inv = await t.call("POST", "/staff/invitations", { token: owner.token, body: { email, fullName: "Staff Person", roleId: role.id } });
  assert.equal(inv.status, 201);
  const token = inv.data.inviteUrl.split("/invite/")[1];
  const info = await t.call("GET", `/auth/invitations/${token}`);
  assert.equal(info.data.roleName, roleName);
  const acc = await t.call("POST", `/auth/invitations/${token}/accept`, { body: { fullName: "Staff Person", password: "Staffpass1" } });
  assert.equal(acc.status, 201);
  return { token: acc.data.token, user: acc.data.user, inviteToken: token };
}

test("invitation flow: link works once, then is spent", async () => {
  const owner = await t.registerBusiness();
  const staff = await inviteAndAccept(owner, "Waiter", "waiter@example.com");
  assert.equal(staff.user.role.name, "Waiter");
  assert.equal(staff.user.tenant.id, owner.user.tenant.id);
  const again = await t.call("POST", `/auth/invitations/${staff.inviteToken}/accept`, { body: { fullName: "Other", password: "Staffpass1" } });
  assert.equal(again.status, 409);
  assert.equal((await t.call("GET", "/auth/invitations/not-a-token")).status, 404);
});

test("permissions are enforced by the role's permission set, not its name", async () => {
  const owner = await t.registerBusiness();
  const waiter = await inviteAndAccept(owner, "Waiter", "w2@example.com");
  assert.equal((await t.call("GET", "/auth/me", { token: waiter.token })).status, 200);
  assert.equal((await t.call("GET", "/roles", { token: waiter.token })).status, 403);
  assert.equal((await t.call("GET", "/staff", { token: waiter.token })).status, 403);
  assert.equal((await t.call("GET", "/billing/subscription", { token: waiter.token })).status, 403);
  assert.equal((await t.call("GET", "/audit-logs", { token: waiter.token })).status, 403);
  assert.equal((await t.call("PATCH", "/tenant", { token: waiter.token, body: {} })).status, 403);

  // Owner grants the Waiter role staff.view -> takes effect immediately
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const wr = roles.find((r) => r.name === "Waiter");
  const upd = await t.call("PATCH", `/roles/${wr.id}`, { token: owner.token, body: { permissions: [...wr.permissions, "staff.view"] } });
  assert.equal(upd.status, 200);
  assert.equal((await t.call("GET", "/staff", { token: waiter.token })).status, 200);
});

test("role rules: owner role locked, system roles can't be deleted, in-use roles can't be deleted", async () => {
  const owner = await t.registerBusiness();
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const ownerRole = roles.find((r) => r.isOwner);
  assert.equal((await t.call("PATCH", `/roles/${ownerRole.id}`, { token: owner.token, body: { permissions: [] } })).status, 403);
  const waiter = roles.find((r) => r.name === "Waiter");
  assert.equal((await t.call("DELETE", `/roles/${waiter.id}`, { token: owner.token })).status, 403);
  assert.equal((await t.call("PATCH", `/roles/${waiter.id}`, { token: owner.token, body: { name: "Server" } })).status, 400);

  const custom = await t.call("POST", "/roles", { token: owner.token, body: { name: "Floor lead", description: "x", permissions: ["orders.view", "tables.view", "orders.view"] } });
  assert.equal(custom.status, 201);
  assert.deepEqual(custom.data.permissions, ["orders.view", "tables.view"]);
  assert.equal((await t.call("POST", "/roles", { token: owner.token, body: { name: "Floor lead", permissions: [] } })).status, 409);
  assert.equal((await t.call("POST", "/roles", { token: owner.token, body: { name: "Bad", permissions: ["orders.explode"] } })).status, 400);

  await inviteAndAccept({ ...owner }, "Waiter", "inuse@example.com"); // sanity for later
  const inv = await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "lead@example.com", roleId: custom.data.id } });
  assert.equal(inv.status, 201);
  assert.equal((await t.call("DELETE", `/roles/${custom.data.id}`, { token: owner.token })).status, 409, "pending invite blocks delete");
  const revoke = await t.call("DELETE", `/staff/invitations/${inv.data.invitation.id}`, { token: owner.token });
  assert.equal(revoke.status, 200);
  assert.equal((await t.call("DELETE", `/roles/${custom.data.id}`, { token: owner.token })).status, 200);
});

test("privilege escalation is blocked: a Manager can't grant billing, invite Owners, or edit their own role", async () => {
  const owner = await t.registerBusiness();
  const manager = await inviteAndAccept(owner, "Manager", "mgr@example.com");
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const mgrRole = roles.find((r) => r.name === "Manager");

  // Manager has no roles.* by default; give them roles.create + roles.update (but not billing)
  await t.call("PATCH", `/roles/${mgrRole.id}`, { token: owner.token, body: { permissions: [...mgrRole.permissions, "roles.view", "roles.create", "roles.update", "staff.create"] } });

  const grabBilling = await t.call("POST", "/roles", { token: manager.token, body: { name: "Sneaky", permissions: ["billing.manage"] } });
  assert.equal(grabBilling.status, 403);
  const editOwn = await t.call("PATCH", `/roles/${mgrRole.id}`, { token: manager.token, body: { permissions: [...mgrRole.permissions, "billing.manage"] } });
  assert.equal(editOwn.status, 403);
  const ownerRole = roles.find((r) => r.isOwner);
  const inviteOwner = await t.call("POST", "/staff/invitations", { token: manager.token, body: { email: "boss@example.com", roleId: ownerRole.id } });
  assert.equal(inviteOwner.status, 400);
});

test("staff management: change role, deactivate (blocks login), reactivate; owner & self are protected", async () => {
  const owner = await t.registerBusiness();
  const staff = await inviteAndAccept(owner, "Waiter", "s1@example.com");
  const list = (await t.call("GET", "/staff", { token: owner.token })).data;
  const ownerRow = list.find((s) => s.role.isOwner);
  const waiterRow = list.find((s) => s.email === "s1@example.com");
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;

  assert.equal((await t.call("PATCH", `/staff/${ownerRow.id}`, { token: owner.token, body: { isActive: false } })).status, 403);
  const changed = await t.call("PATCH", `/staff/${waiterRow.id}`, { token: owner.token, body: { roleId: roles.find((r) => r.name === "Cashier").id } });
  assert.equal(changed.data.role.name, "Cashier");

  const off = await t.call("PATCH", `/staff/${waiterRow.id}`, { token: owner.token, body: { isActive: false } });
  assert.equal(off.data.isActive, false);
  assert.equal((await t.call("GET", "/auth/me", { token: staff.token })).status, 401, "deactivated user's token stops working");
  assert.equal((await t.call("POST", "/auth/login", { body: { email: "s1@example.com", password: "Staffpass1" } })).status, 401);
  const on = await t.call("PATCH", `/staff/${waiterRow.id}`, { token: owner.token, body: { isActive: true } });
  assert.equal(on.data.isActive, true);
  assert.equal((await t.call("POST", "/auth/login", { body: { email: "s1@example.com", password: "Staffpass1" } })).status, 200);

  // can't invite someone who already has an account
  const dup = await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "s1@example.com", roleId: roles[2].id } });
  assert.equal(dup.status, 409);
});

test("business profile edit, branch edit, logo upload validation and storage", async () => {
  const owner = await t.registerBusiness();
  const prof = await t.call("PATCH", "/tenant", { token: owner.token, body: { name: "Renamed", businessType: "BAKERY", description: "Fresh bread", phone: "0788000000", email: "hi@example.com", address: "KG 7 Ave", city: "Kigali", brandColor: "#112233" } });
  assert.equal(prof.status, 200);
  assert.equal(prof.data.slug.startsWith("test-cafe"), true, "slug never changes");
  assert.equal((await t.call("PATCH", "/tenant", { token: owner.token, body: { ...prof.data, brandColor: "red" } })).status, 400);

  const tenant = (await t.call("GET", "/tenant", { token: owner.token })).data;
  const br = await t.call("PATCH", `/tenant/branches/${tenant.branches[0].id}`, { token: owner.token, body: { name: "Kimihurura", address: "KG 9", phone: "0788", opensAt: "06:30", closesAt: "22:00" } });
  assert.equal(br.data.opensAt, "06:30");
  assert.equal((await t.call("PATCH", `/tenant/branches/${tenant.branches[0].id}`, { token: owner.token, body: { name: "x1", opensAt: "25:00", closesAt: "22:00" } })).status, 400);

  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c489", "hex");
  const fd = new FormData(); fd.append("logo", new Blob([png], { type: "image/png" }), "logo.png");
  const up = await t.call("POST", "/tenant/logo", { token: owner.token, form: fd });
  assert.equal(up.status, 200);
  assert.match(up.data.logoUrl, /\/uploads\/tenants\/.+\/logo\/[a-f0-9]{16}\.png$/);
  const served = await fetch(up.data.logoUrl.replace(/^https?:\/\/[^/]+/, t.base.replace("/api/v1", "")));
  assert.equal(served.status, 200);

  const fake = new FormData(); fake.append("logo", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "evil.png");
  assert.equal((await t.call("POST", "/tenant/logo", { token: owner.token, form: fake })).status, 400);

  const del = await t.call("DELETE", "/tenant/logo", { token: owner.token });
  assert.equal(del.data.logoUrl, null);
});

test("dashboard summary reflects real progress", async () => {
  const owner = await t.registerBusiness();
  const s1 = (await t.call("GET", "/dashboard/summary", { token: owner.token })).data;
  assert.equal(s1.checklist.find((c) => c.key === "team").done, false);
  assert.equal(s1.team.activeStaff, 1);
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  await t.call("POST", "/staff/invitations", { token: owner.token, body: { email: "d@example.com", roleId: roles[2].id } });
  const s2 = (await t.call("GET", "/dashboard/summary", { token: owner.token })).data;
  assert.equal(s2.checklist.find((c) => c.key === "team").done, true);
  assert.equal(s2.team.pendingInvites, 1);
  assert.match(s2.publicUrl, /\/r\//);
});

test("assignable roles: managers only see roles within their own access; waiters see none", async () => {
  const owner = await t.registerBusiness();
  const mgr = await inviteAndAccept(owner, "Manager", "assign-mgr@example.com");
  const waiter = await inviteAndAccept(owner, "Waiter", "assign-w@example.com");
  const ownerList = (await t.call("GET", "/staff/assignable-roles", { token: owner.token })).data.map((r) => r.name);
  assert.ok(!ownerList.includes("Owner")); assert.ok(ownerList.includes("Manager"));
  const mgrList = await t.call("GET", "/staff/assignable-roles", { token: mgr.token });
  assert.equal(mgrList.status, 200);
  assert.ok(mgrList.data.map((r) => r.name).includes("Waiter"));
  assert.ok(!mgrList.data.map((r) => r.name).includes("Owner"));
  assert.equal((await t.call("GET", "/staff/assignable-roles", { token: waiter.token })).status, 403);
});
