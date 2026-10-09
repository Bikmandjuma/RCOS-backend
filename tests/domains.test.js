import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";
import { setDnsResolver, forgetDomainCache } from "../src/modules/tenants/domains.service.js";

let t;
before(async () => { t = await bootstrap("domains"); });
after(async () => { await t.close(); });

const records = {}; // what "DNS" currently says: { "_restaurantos.shop.test": [["restaurantos-verify=..."]], "shop.test": ["domains.localhost"] }
setDnsResolver({
  resolveTxt: async (name) => { if (!records[name]) throw Object.assign(new Error("no"), { code: "ENODATA" }); if (records[name] === "FAIL") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); return records[name]; },
  resolveCname: async (name) => { if (!records[name]) throw Object.assign(new Error("no"), { code: "ENODATA" }); return records[name]; },
});
const put = (tk, domain) => t.call("PUT", "/tenant/domain", { token: tk, body: { domain } });
const verify = (tk) => t.call("POST", "/tenant/domain/verify", { token: tk });
const preflight = (origin) => fetch(`${t.base}/public/domain/resolve?host=x`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });

test("domain names are validated and normalised; the platform's own addresses can't be claimed", async () => {
  const owner = await t.registerBusiness({ businessName: "Domain Cafe" });
  for (const bad of ["", "   ", "https://shop.test", "shop.test:8080", "shop.test/menu", "shop test", "localhost", "app.localhost", "1.2.3.4", "no-tld", "-bad.shop.test", "shop..test", "a@b.test", "x".repeat(70) + ".test"]) {
    assert.equal((await put(owner.token, bad)).status, 400, `should reject "${bad}"`);
  }
  const r = await put(owner.token, "  Order.Domain-Cafe.RW ");
  assert.equal(r.status, 200); assert.equal(r.data.domain, "order.domain-cafe.rw", "lower-cased and trimmed");
  assert.equal(r.data.verified, false);
  assert.equal(r.data.records.ownership.name, "_restaurantos.order.domain-cafe.rw");
  assert.match(r.data.records.ownership.value, /^restaurantos-verify=[0-9a-f]{32}$/);
  assert.equal(r.data.records.pointer.type, "CNAME"); assert.equal(r.data.records.pointer.name, "order.domain-cafe.rw");
  assert.equal(r.data.publicBase.includes("order.domain-cafe.rw"), false, "links stay on the platform until verified");
  const again = await put(owner.token, "order.domain-cafe.rw");
  assert.equal(again.data.records.ownership.value, r.data.records.ownership.value, "the same domain keeps the same proof token");
  const changed = await put(owner.token, "other.domain-cafe.rw");
  assert.notEqual(changed.data.records.ownership.value, r.data.records.ownership.value, "a different domain gets a fresh token");
});

test("verification needs the TXT record: missing, wrong, DNS outage, then success", async () => {
  const owner = await t.registerBusiness({ businessName: "Proof Cafe" });
  const rec = (await put(owner.token, "shop.test")).data.records;
  const miss = await verify(owner.token); assert.equal(miss.status, 409); assert.match(miss.body.message, /didn't find any TXT record/);
  records[rec.ownership.name] = [["restaurantos-verify=somebody-elses-token"]];
  const wrong = await verify(owner.token); assert.equal(wrong.status, 409); assert.match(wrong.body.message, /We found: restaurantos-verify=somebody-elses-token/);
  records[rec.ownership.name] = "FAIL";
  const outage = await verify(owner.token); assert.equal(outage.status, 503); assert.match(outage.body.message, /try again in a minute/);
  assert.equal((await t.call("GET", "/tenant/domain", { token: owner.token })).data.verified, false);

  // long TXT values arrive split into chunks: they must be joined before comparing
  const v = rec.ownership.value; records[rec.ownership.name] = [["unrelated=1"], [v.slice(0, 10), v.slice(10)]];
  const good = await verify(owner.token);
  assert.equal(good.status, 200, JSON.stringify(good.body)); assert.equal(good.data.verified, true); assert.equal(good.data.pointsHere, null, "no CNAME yet: informational only");
  records["shop.test"] = ["domains.localhost."];
  assert.equal((await verify(owner.token)).data.pointsHere, true, "trailing dots and case don't matter");
  assert.equal((await t.call("GET", "/tenant/domain", { token: owner.token })).data.publicBase, "http://shop.test");
});

test("a verified domain takes over links, is served by the resolver and the TLS check, and is allowed by CORS", async () => {
  const owner = await t.registerBusiness({ businessName: "Verified Cafe" });
  const tbl = (await t.call("POST", "/tables", { token: owner.token, body: { count: 1 } })).data[0];
  assert.equal(tbl.qrUrl, `http://localhost:5173/q/${tbl.qrToken}`);
  const rec = (await put(owner.token, "verified.test")).data.records; records[rec.ownership.name] = [[rec.ownership.value]];
  assert.equal((await t.call("GET", "/public/domain/resolve?host=verified.test")).status, 404, "a claim isn't served until it's proven");
  assert.equal((await verify(owner.token)).status, 200);

  const tables = (await t.call("GET", "/tables", { token: owner.token })).data;
  assert.equal(tables[0].qrUrl, `http://verified.test/q/${tbl.qrToken}`, "QR links now use the business's domain");
  assert.equal((await t.call("GET", "/dashboard/summary", { token: owner.token })).data.publicUrl, "http://verified.test");
  const res = await t.call("GET", "/public/domain/resolve?host=VERIFIED.test");
  assert.equal(res.status, 200); assert.equal(res.data.slug, owner.user.tenant.slug); assert.ok(res.data.platformUrl);
  assert.equal((await t.call("GET", "/public/domain/resolve?host=nobody.test")).status, 404);
  assert.equal((await t.call("GET", "/public/domain/resolve")).status, 404);

  for (const q of ["verified.test", "unclaimed.test"]) { const r = await fetch(`${t.base}/public/domain/resolve?host=${q}`, { headers: { Origin: `http://${q}:5173` } }); assert.equal(r.headers.get("access-control-allow-origin"), "*", `the lookup answers any origin (${r.status})`); }
  assert.equal((await fetch(`${t.base}/public/plans`, { headers: { Origin: "http://evil.test" } })).headers.get("access-control-allow-origin"), null, "everything else stays restricted");
  assert.equal((await fetch(`${t.base}/public/domain/check?domain=verified.test`)).status, 200);
  assert.equal((await fetch(`${t.base}/public/domain/check?domain=localhost`)).status, 200, "the platform's own host is allowed too");
  assert.equal((await fetch(`${t.base}/public/domain/check?domain=evil.test`)).status, 404, "never request a certificate for a domain we don't serve");
  assert.equal((await fetch(`${t.base}/public/domain/check`)).status, 404);

  const okPre = await preflight("http://verified.test"); assert.equal(okPre.headers.get("access-control-allow-origin"), "http://verified.test");
  const badPre = await preflight("http://evil.test"); assert.equal(badPre.headers.get("access-control-allow-origin"), null);
  assert.equal((await preflight("http://localhost:5173")).headers.get("access-control-allow-origin"), "http://localhost:5173");

  // the old platform link keeps working, so printed QR codes never break
  assert.equal((await t.call("GET", `/public/q/${tbl.qrToken}`)).status, 200);

  // suspension takes the domain offline
  await t.prisma.tenant.update({ where: { id: owner.user.tenant.id }, data: { status: "SUSPENDED" } }); forgetDomainCache();
  assert.equal((await t.call("GET", "/public/domain/resolve?host=verified.test")).status, 404);
  assert.equal((await preflight("http://verified.test")).headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${t.base}/public/domain/check?domain=verified.test`)).status, 404);
  await t.prisma.tenant.update({ where: { id: owner.user.tenant.id }, data: { status: "ACTIVE" } }); forgetDomainCache();

  // removing it puts everything back
  assert.equal((await t.call("DELETE", "/tenant/domain", { token: owner.token })).status, 200);
  assert.equal((await t.call("GET", "/tables", { token: owner.token })).data[0].qrUrl, `http://localhost:5173/q/${tbl.qrToken}`);
  assert.equal((await t.call("GET", "/public/domain/resolve?host=verified.test")).status, 404);
  assert.equal((await preflight("http://verified.test")).headers.get("access-control-allow-origin"), null, "CORS stops at once");
  assert.equal((await t.call("DELETE", "/tenant/domain", { token: owner.token })).status, 200, "removing twice is harmless");
});

test("squatting: anyone may claim a name, but only one business can ever prove it; changing domain drops the old proof", async () => {
  const a = await t.registerBusiness({ businessName: "Real Owner" }), b = await t.registerBusiness({ businessName: "Squatter" });
  const ra = (await put(a.token, "bigbrand.test")).data.records, rb = (await put(b.token, "bigbrand.test")).data.records;
  assert.notEqual(ra.ownership.value, rb.ownership.value, "each claim has its own token");
  assert.equal((await verify(b.token)).status, 409, "the squatter can't prove it");
  records[ra.ownership.name] = [[ra.ownership.value]];
  assert.equal((await verify(a.token)).status, 200);
  assert.equal((await t.call("GET", "/public/domain/resolve?host=bigbrand.test")).data.slug, a.user.tenant.slug);
  // even if the squatter later can show *their* token (e.g. an ex-owner's DNS), the domain is taken
  records[rb.ownership.name] = [[rb.ownership.value]];
  const late = await verify(b.token); assert.equal(late.status, 409); assert.match(late.body.message, /already connected to another business/);
  assert.equal((await t.call("GET", "/public/domain/resolve?host=bigbrand.test")).data.slug, a.user.tenant.slug, "still the real owner");

  // switching to a new domain un-verifies the old one right away
  await put(a.token, "newname.test");
  assert.equal((await t.call("GET", "/tenant/domain", { token: a.token })).data.verified, false);
  assert.equal((await t.call("GET", "/public/domain/resolve?host=bigbrand.test")).status, 404);
  assert.equal((await t.prisma.tenant.findUnique({ where: { id: a.user.tenant.id } })).verifiedDomain, null);
});

test("permissions, subscription and audit trail", async () => {
  const owner = await t.registerBusiness({ businessName: "Perm Cafe" });
  const roles = (await t.call("GET", "/roles", { token: owner.token })).data;
  const staff = async (name, email) => { const inv = await t.call("POST", "/staff/invitations", { token: owner.token, body: { email, roleId: roles.find((r) => r.name === name).id } }); return (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: `${name} Person`, password: "Staffpass1" } })).data.token; };
  const waiter = await staff("Waiter", "w@perm.rw"), manager = await staff("Manager", "m@perm.rw");
  assert.equal((await put(waiter, "perm.test")).status, 403); assert.equal((await t.call("GET", "/tenant/domain", { token: waiter })).status, 403);
  assert.equal((await verify(waiter)).status, 403);
  assert.equal((await t.call("GET", "/tenant/domain", { token: manager })).status, 200, "managers can see the settings");
  assert.equal((await put(manager, "perm.test")).status, 403, "but changing the domain is an owner decision");
  assert.equal((await put(owner.token, "perm.test")).status, 200);
  assert.equal((await verify(owner.token)).status, 409, "no record yet");
  assert.equal((await t.call("PUT", "/tenant/domain", { body: { domain: "x.test" } })).status, 401);
  assert.equal((await verify((await t.registerBusiness()).token)).status, 404, "nothing to verify without a domain");

  await t.prisma.subscription.update({ where: { tenantId: owner.user.tenant.id }, data: { trialEndsAt: new Date(Date.now() - 86400000), currentPeriodEnd: null } });
  assert.equal((await put(owner.token, "late.test")).status, 402, "an expired subscription can't change its domain");
  const logs = (await t.call("GET", "/audit-logs?pageSize=20", { token: owner.token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs, /Started connecting the domain perm.test/);
});
