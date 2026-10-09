import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { bootstrap } from "./helpers.js";

let t;
before(async () => { t = await bootstrap("seed"); });
after(async () => { await t.close(); });

// Runs the real scripts exactly as `npm run` would (separate processes), against this test file's database.
const run = (script, args = [], env = {}) => spawnSync("node", [script, ...args], {
  cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, NODE_ENV: "development", ADMIN_EMAIL: "", ADMIN_PASSWORD: "", ADMIN_NAME: "", DEMO_PASSWORD: "", ...env },
});
const adminLogin = (email, password) => t.call("POST", "/admin/login", { body: { email, password } });

test("db:setup creates the first platform administrator, once, and never changes it afterwards", async () => {
  const first = run("prisma/seed.js");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Platform administrator created/); assert.match(first.stdout, /admin@restaurantos\.local/); assert.match(first.stdout, /ChangeMe-Dev-Only-123/);
  const login = await adminLogin("admin@restaurantos.local", "ChangeMe-Dev-Only-123");
  assert.equal(login.status, 200); assert.equal(login.data.user.role, "SUPER_ADMIN");

  const again = run("prisma/seed.js");
  assert.equal(again.status, 0); assert.match(again.stdout, /already exists \(password unchanged\)/);
  assert.equal((await t.prisma.platformUser.count()), 1, "no duplicates");

  const custom = run("prisma/seed.js", [], { ADMIN_EMAIL: "owner@mycompany.rw", ADMIN_PASSWORD: "a-much-longer-passphrase", ADMIN_NAME: "Real Owner" });
  assert.equal(custom.status, 0); assert.match(custom.stdout, /owner@mycompany\.rw/); assert.doesNotMatch(custom.stdout, /a-much-longer-passphrase/, "a chosen password is never printed");
  assert.equal((await adminLogin("owner@mycompany.rw", "a-much-longer-passphrase")).status, 200);
});

test("production never gets the placeholder: no admin without explicit details, and the placeholder is refused", async () => {
  const prod = { NODE_ENV: "production", JWT_SECRET: "x".repeat(40) };
  const none = run("prisma/seed.js", [], prod);
  assert.equal(none.status, 0); assert.match(none.stdout, /No platform administrator was created/); assert.match(none.stdout, /admin:create/);
  assert.equal(await t.prisma.platformUser.count({ where: { email: "nobody@prod.rw" } }), 0);
  const placeholder = run("prisma/seed.js", [], { ...prod, ADMIN_EMAIL: "boss@prod.rw", ADMIN_PASSWORD: "ChangeMe-Dev-Only-123" });
  assert.equal(placeholder.status, 1); assert.match(placeholder.stderr, /Refusing to use the development placeholder/);
  assert.equal(await t.prisma.platformUser.count({ where: { email: "boss@prod.rw" } }), 0);
  const short = run("prisma/seed.js", [], { ...prod, ADMIN_EMAIL: "boss@prod.rw", ADMIN_PASSWORD: "short" });
  assert.equal(short.status, 1); assert.match(short.stderr, /at least 12 characters/);
  const good = run("prisma/seed.js", [], { ...prod, ADMIN_EMAIL: "boss@prod.rw", ADMIN_PASSWORD: "a-proper-long-passphrase" });
  assert.equal(good.status, 0); assert.equal((await adminLogin("boss@prod.rw", "a-proper-long-passphrase")).status, 200);
});

test("admin:create works with plain arguments (no shell-specific syntax), can make support accounts and reset passwords", async () => {
  const make = run("scripts/create-platform-admin.js", ["--email", "help@mycompany.rw", "--password", "a-support-passphrase", "--name", "Sam Support", "--role", "SUPPORT"]);
  assert.equal(make.status, 0, make.stderr); assert.match(make.stdout, /SUPPORT created/);
  assert.equal((await adminLogin("help@mycompany.rw", "a-support-passphrase")).data.user.role, "SUPPORT");
  const reset = run("scripts/create-platform-admin.js", ["--email", "help@mycompany.rw", "--password", "a-brand-new-passphrase"]);
  assert.equal(reset.status, 0); assert.match(reset.stdout, /password reset/);
  assert.equal((await adminLogin("help@mycompany.rw", "a-support-passphrase")).status, 401, "the old password stops working");
  assert.equal((await adminLogin("help@mycompany.rw", "a-brand-new-passphrase")).status, 200);
  const fromEnv = run("scripts/create-platform-admin.js", [], { ADMIN_EMAIL: "env@mycompany.rw", ADMIN_PASSWORD: "an-env-provided-passphrase" });
  assert.equal(fromEnv.status, 0, fromEnv.stderr); assert.equal((await adminLogin("env@mycompany.rw", "an-env-provided-passphrase")).status, 200);
  const bad = run("scripts/create-platform-admin.js", ["--email", "x@y.rw", "--password", "tooshort"]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /at least 12 characters/);
  const missing = run("scripts/create-platform-admin.js", []);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Missing details/);
});

test("db:demo builds a coherent demo business: sign-in for every role, and data that adds up", async () => {
  const prod = run("prisma/demo.js", [], { NODE_ENV: "production", JWT_SECRET: "x".repeat(40) });
  assert.equal(prod.status, 1); assert.match(prod.stderr, /Refusing to create demo accounts in production/);
  assert.equal(await t.prisma.user.count(), 0, "nothing was created");

  const demo = run("prisma/demo.js");
  assert.equal(demo.status, 0, demo.stderr + demo.stdout); assert.match(demo.stdout, /Demo business ready/);
  for (const who of ["demo", "manager", "cashier", "waiter", "kitchen"]) {
    const r = await t.call("POST", "/auth/login", { body: { email: `${who}@restaurantos.local`, password: "Demo#12345678" } });
    assert.equal(r.status, 200, `${who} can sign in`);
  }
  const owner = (await t.call("POST", "/auth/login", { body: { email: "demo@restaurantos.local", password: "Demo#12345678" } })).data.token;

  // stock: every ingredient equals the sum of its history, and the last movement's balance is the current stock
  for (const i of await t.prisma.ingredient.findMany()) {
    const moves = await t.prisma.stockMovement.findMany({ where: { ingredientId: i.id }, orderBy: { createdAt: "asc" } });
    assert.equal(moves.reduce((n, m) => n + m.quantity, 0), i.quantity, `${i.name}: history adds up`);
    assert.equal(moves.at(-1).balanceAfter, i.quantity);
    let run = 0; for (const m of moves) { run += m.quantity; assert.equal(m.balanceAfter, run, `${i.name}: running balance`); assert.ok(run >= 0, `${i.name}: never negative`); }
  }
  // loyalty: points equal their ledger
  for (const c of await t.prisma.customer.findMany()) {
    const sum = (await t.prisma.loyaltyTransaction.findMany({ where: { customerId: c.id } })).reduce((n, x) => n + x.points, 0);
    assert.equal(c.loyaltyPoints, sum, `${c.name}: points match the ledger`);
  }
  // orders: totals match their lines
  for (const o of await t.prisma.order.findMany({ include: { items: true }, take: 200 })) assert.equal(o.totalRwf, o.items.reduce((n, x) => n + x.quantity * x.unitPriceRwf, 0) - o.discountRwf, `order #${o.number} total`);

  const a = (await t.call("GET", "/analytics/overview?days=30", { token: owner })).data;
  assert.ok(a.totals.orders > 100, `plenty of orders (${a.totals.orders})`); assert.ok(a.margins.length >= 3, "margins from recipes"); assert.ok(a.peakHour >= 7 && a.peakHour <= 18);
  assert.equal((await t.call("GET", "/analytics/forecast", { token: owner })).data.enough, true, "enough history to forecast");
  assert.ok((await t.call("GET", "/analytics/alerts", { token: owner })).data.alerts.some((x) => x.key === "stock"), "the demo has an ingredient running low");
  assert.ok((await t.call("GET", "/customers", { token: owner })).data.totalCustomers >= 8);
  const kitchen = (await t.call("GET", "/orders/kitchen", { token: owner })).data;
  assert.ok(kitchen.length >= 3, "live orders in the kitchen");
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.ok((await t.call("GET", `/reservations?date=${day}`, { token: owner })).data.items.length >= 2, "bookings for tomorrow");
  assert.equal((await t.call("GET", "/public/restaurants/demo-cafe")).data.rating.count, 3, "reviews on the public page");

  const again = run("prisma/demo.js"); assert.equal(again.status, 0); assert.match(again.stdout, /already exists/);
  assert.equal(await t.prisma.tenant.count(), 1, "running twice doesn't duplicate");
});
