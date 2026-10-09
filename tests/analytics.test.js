import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { bootstrap } from "./helpers.js";
import { todayYmd } from "../src/shared/time.js";
import { addDays } from "../src/modules/analytics/analytics.service.js";

let t;
before(async () => { t = await bootstrap("analytics"); });
after(async () => { await t.close(); });

const TZ = "Africa/Kigali"; // UTC+2, no DST
const today = () => todayYmd(TZ);
// A local (Kigali) wall-clock time N days ago, as an instant.
const at = (daysAgo, hour = 12, minute = 0) => { const [y, m, d] = addDays(today(), -daysAgo).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, hour - 2, minute)); };

let n = 0;
async function shop(name) {
  n += 1;
  const reg = await t.registerBusiness({ businessName: `${name} ${n}` });
  const tk = reg.token, tenantId = reg.user.tenant.id;
  const branch = await t.prisma.branch.findFirst({ where: { tenantId } });
  const cat = (await t.call("POST", "/menu/categories", { token: tk, body: { name: "Drinks" } })).data;
  const mk = async (nm, price) => (await t.call("POST", "/menu/products", { token: tk, body: { categoryId: cat.id, name: nm, priceRwf: price } })).data;
  const latte = await mk("Latte", 4000), cake = await mk("Cake", 2500), tea = await mk("Tea", 1000);
  let num = 1000;
  const seed = async ({ items, daysAgo, hour = 12, method = "MOBILE_MONEY", discount = 0, status = "COMPLETED", payment = "CONFIRMED", minsAgo }) => {
    const created = minsAgo !== undefined ? new Date(Date.now() - minsAgo * 60000) : at(daysAgo, hour);
    const subtotal = items.reduce((s, i) => s + i.p.priceRwf * i.q, 0);
    num += 1;
    return t.prisma.order.create({ data: {
      tenantId, branchId: branch.id, number: num, publicToken: crypto.randomBytes(12).toString("hex"), customerName: "Seed", status, paymentStatus: payment,
      paymentMethod: payment === "CONFIRMED" ? method : null, paidAt: payment === "CONFIRMED" ? new Date(created.getTime() + 300000) : null, createdAt: created,
      subtotalRwf: subtotal, discountRwf: discount, totalRwf: subtotal - discount, proofRequired: false,
      items: { create: items.map((i) => ({ productId: i.p.id, name: i.p.name, unitPriceRwf: i.p.priceRwf, quantity: i.q })) },
    } });
  };
  return { tk, tenantId, branch, latte, cake, tea, seed, reg };
}

test("overview: totals, previous-period change, daily series, hours, products, payment mix, promotions", async () => {
  const s = await shop("Numbers");
  await s.seed({ items: [{ p: s.latte, q: 2 }], daysAgo: 0, hour: 9, method: "CASH" });                      // 8,000
  await s.seed({ items: [{ p: s.latte, q: 1 }], daysAgo: 1, hour: 15 });                                       // 4,000
  await s.seed({ items: [{ p: s.cake, q: 2 }], daysAgo: 1, hour: 15 });                                        // 5,000
  await s.seed({ items: [{ p: s.latte, q: 3 }], daysAgo: 3, hour: 15, discount: 1200 });                       // 12,000 − 1,200 = 10,800
  await s.seed({ items: [{ p: s.latte, q: 1 }], daysAgo: 10, hour: 11 });                                      // previous period: 4,000
  await s.seed({ items: [{ p: s.cake, q: 1 }], daysAgo: 2, hour: 10, payment: "PROOF_SUBMITTED", status: "PLACED" }); // unpaid: never counted
  await s.seed({ items: [{ p: s.cake, q: 1 }], daysAgo: 2, hour: 10, status: "CANCELLED" });                    // cancelled: never counted
  const order1 = await t.prisma.order.findFirst({ where: { tenantId: s.tenantId, createdAt: at(1, 15) } });
  await t.prisma.refund.create({ data: { tenantId: s.tenantId, orderId: order1.id, amountRwf: 1000, reason: "x", method: "CASH", createdAt: at(1, 16) } });
  await t.prisma.customer.create({ data: { tenantId: s.tenantId, name: "New Person" } });

  const r = await t.call("GET", "/analytics/overview?days=7", { token: s.tk });
  assert.equal(r.status, 200); const o = r.data;
  assert.deepEqual([o.totals.grossRwf, o.totals.orders, o.totals.refundsRwf, o.totals.netRwf, o.totals.averageOrderRwf], [27800, 4, 1000, 26800, 6950]);
  assert.deepEqual([o.previous.grossRwf, o.previous.orders], [4000, 1]);
  assert.equal(o.change.grossPct, 595); assert.equal(o.change.ordersPct, 300);
  assert.equal(o.daily.length, 7); assert.equal(o.daily.at(-1).date, today());
  const d1 = o.daily.find((d) => d.date === addDays(today(), -1)); assert.deepEqual([d1.grossRwf, d1.refundsRwf, d1.netRwf, d1.orders], [9000, 1000, 8000, 2]);
  assert.equal(o.hours[15].orders, 3); assert.equal(o.hours[9].orders, 1); assert.equal(o.peakHour, 15);
  assert.equal(o.topProducts[0].name, "Latte"); assert.deepEqual([o.topProducts[0].quantity, o.topProducts[0].revenueRwf], [6, 24000]);
  assert.deepEqual(o.paymentMix.map((p) => [p.method, p.orders, p.amountRwf]), [["MOBILE_MONEY", 3, 19800], ["CASH", 1, 8000]]);
  assert.deepEqual([o.promotions.discountRwf, o.promotions.discountedOrders], [1200, 1]);
  assert.equal(o.customers.newCustomers, 1);
  assert.equal(o.worstSellers[0].name, "Tea"); assert.equal(o.worstSellers[0].quantity, 0, "items nobody ordered are listed first");

  // 30 days now includes the old order as current
  assert.equal((await t.call("GET", "/analytics/overview", { token: s.tk })).data.totals.orders, 5);
  assert.equal((await t.call("GET", "/analytics/overview?days=15", { token: s.tk })).status, 400);

  const other = await shop("Other");
  assert.equal((await t.call("GET", "/analytics/overview?days=7", { token: other.tk })).data.totals.orders, 0, "tenants never see each other's numbers");
});

test("profitability uses recipes and current ingredient costs; waste cost is counted", async () => {
  const s = await shop("Margins");
  const beans = (await t.call("POST", "/inventory/ingredients", { token: s.tk, body: { name: "Beans", unit: "G", unitCostRwf: 25, openingQuantity: 5000 } })).data;
  await t.call("PUT", `/inventory/recipes/${s.latte.id}`, { token: s.tk, body: { items: [{ ingredientId: beans.id, quantity: 20 }] } }); // 500 per cup
  await s.seed({ items: [{ p: s.latte, q: 6 }], daysAgo: 1 }); await s.seed({ items: [{ p: s.cake, q: 2 }], daysAgo: 1 });
  await t.call("POST", `/inventory/ingredients/${beans.id}/waste`, { token: s.tk, body: { quantity: 200, reason: "Spilled" } });
  const o = (await t.call("GET", "/analytics/overview?days=7", { token: s.tk })).data;
  assert.equal(o.margins.length, 1, "only items with a recipe have a margin");
  assert.deepEqual([o.margins[0].name, o.margins[0].costRwf, o.margins[0].marginRwf, o.margins[0].marginPct], ["Latte", 3000, 21000, 88]);
  assert.deepEqual([o.waste.totalCostRwf, o.waste.items[0].ingredient, o.waste.items[0].quantity], [5000, "Beans", 200]);
});

test("forecast: same-weekday averages with a spread, product demand, ingredient shortfall, and honesty about thin history", async () => {
  const s = await shop("Forecast");
  const beans = (await t.call("POST", "/inventory/ingredients", { token: s.tk, body: { name: "Beans", unit: "G", unitCostRwf: 25, openingQuantity: 30 } })).data;
  await t.call("PUT", `/inventory/recipes/${s.latte.id}`, { token: s.tk, body: { items: [{ ingredientId: beans.id, quantity: 20 }] } });
  // tomorrow's weekday, 4 weeks back: 1, 2, 3, 4 lattes (4,000 each) → 4k, 8k, 12k, 16k  (mean 10k)
  for (const [daysAgo, count] of [[27, 1], [20, 2], [13, 3], [6, 4]]) for (let i = 0; i < count; i++) await s.seed({ items: [{ p: s.latte, q: 1 }], daysAgo });
  const f = (await t.call("GET", "/analytics/forecast", { token: s.tk })).data;
  const d = f.days[0];
  assert.equal(f.days.length, 7); assert.equal(d.date, addDays(today(), 1)); assert.equal(d.basedOnWeeks, 4);
  assert.deepEqual([d.enough, d.expectedOrders, d.expectedSalesRwf], [true, 3, 10000]); // mean orders 2.5 → 3
  const sd = Math.sqrt((36e6 + 4e6 + 4e6 + 36e6) / 4); // 6,324.6
  assert.equal(d.lowSalesRwf, Math.round(10000 - sd)); assert.equal(d.highSalesRwf, Math.round(10000 + sd));
  assert.deepEqual([f.tomorrow.products[0].name, f.tomorrow.products[0].expectedQuantity], ["Latte", 2.5]);
  const ing = f.tomorrow.ingredients[0];
  assert.deepEqual([ing.name, ing.expectedNeed, ing.inStock, ing.shortBy, ing.mayRunShort], ["Beans", 50, 30, 20, true]);
  assert.match(f.note, /not a guarantee/);

  const thin = await shop("Thin");
  await thin.seed({ items: [{ p: thin.latte, q: 1 }], daysAgo: 1 });
  const ft = (await t.call("GET", "/analytics/forecast", { token: thin.tk })).data;
  assert.equal(ft.enough, false); assert.equal(ft.days[0].expectedOrders, null, "no made-up numbers when there's too little history");
  assert.equal((await t.call("GET", "/analytics/forecast", { token: (await shop("Empty")).tk })).data.historyDays, 0);
});

test("alerts: sales anomalies, unusual ingredient use, refunds, waiting orders, low stock — and quiet when all is normal", async () => {
  const quiet = await shop("Quiet");
  assert.deepEqual((await t.call("GET", "/analytics/alerts", { token: quiet.tk })).data.alerts, []);

  const s = await shop("Alerts");
  for (const w of [1, 2, 3, 4]) { await s.seed({ items: [{ p: s.latte, q: 5 }], daysAgo: 1 + 7 * w }); }     // 20,000 on the same weekday, 4 weeks running
  await s.seed({ items: [{ p: s.latte, q: 1 }], daysAgo: 1 });                                                // yesterday: 4,000 (< 50% of typical)
  const beans = (await t.call("POST", "/inventory/ingredients", { token: s.tk, body: { name: "Beans", unit: "G", unitCostRwf: 25, lowStockAt: 5000, openingQuantity: 10000 } })).data;
  await t.call("POST", `/inventory/ingredients/${beans.id}/count`, { token: s.tk, body: { quantity: 1000 } });  // below its warning level
  for (const d of [2, 3, 4, 5, 6]) await t.prisma.stockMovement.create({ data: { tenantId: s.tenantId, ingredientId: beans.id, type: "SALE", quantity: -100, balanceAfter: 1000, createdAt: at(d, 12) } });
  await t.prisma.stockMovement.create({ data: { tenantId: s.tenantId, ingredientId: beans.id, type: "SALE", quantity: -600, balanceAfter: 400, createdAt: at(1, 12) } }); // 6× normal yesterday
  const paid = await s.seed({ items: [{ p: s.latte, q: 5 }], daysAgo: 2 });
  await t.prisma.refund.create({ data: { tenantId: s.tenantId, orderId: paid.id, amountRwf: 6000, reason: "x", method: "CASH", createdAt: at(2, 13) } });
  const p = await s.seed({ items: [{ p: s.cake, q: 1 }], payment: "PROOF_SUBMITTED", status: "PLACED", minsAgo: 40 });
  const k = await s.seed({ items: [{ p: s.cake, q: 1 }], status: "PLACED", payment: "CONFIRMED", minsAgo: 20 });

  const a = (await t.call("GET", "/analytics/alerts", { token: s.tk })).data.alerts;
  const by = Object.fromEntries(a.map((x) => [x.key.replace(/-.*/, ""), x]));
  assert.equal(by.sales.key, "sales-low"); assert.equal(by.sales.severity, "attention"); assert.match(by.sales.detail, /RWF 4,000 against a typical .* of about RWF 20,000/);
  assert.ok(by.use, "unusual ingredient use flagged"); assert.match(by.use.detail, /Unusual stock variance detected: review/); assert.doesNotMatch(JSON.stringify(a), /theft|stole|steal|fraud/i, "never accuses staff");
  assert.equal(by.refunds.severity, "warning");
  assert.equal(by.proofs.severity, "attention"); assert.match(by.proofs.detail, new RegExp(`#${p.number}`));
  assert.equal(by.kitchen.severity, "attention"); assert.match(by.kitchen.detail, new RegExp(`#${k.number}`));
  assert.ok(by.stock);
  const sev = a.map((x) => x.severity); assert.deepEqual(sev, [...sev].sort((x, y) => ({ attention: 0, warning: 1, info: 2 }[x] - { attention: 0, warning: 1, info: 2 }[y])), "most urgent first");

  const hi = await shop("High");
  for (const w of [1, 2, 3, 4]) await hi.seed({ items: [{ p: hi.latte, q: 5 }], daysAgo: 1 + 7 * w });
  await hi.seed({ items: [{ p: hi.latte, q: 10 }], daysAgo: 1 });
  assert.equal((await t.call("GET", "/analytics/alerts", { token: hi.tk })).data.alerts.find((x) => x.key === "sales-high").severity, "info");
  const few = await shop("Few");
  await few.seed({ items: [{ p: few.latte, q: 5 }], daysAgo: 8 }); await few.seed({ items: [{ p: few.latte, q: 1 }], daysAgo: 1 });
  assert.equal((await t.call("GET", "/analytics/alerts", { token: few.tk })).data.alerts.some((x) => x.key.startsWith("sales")), false, "too little history to call anything unusual");
  assert.deepEqual((await t.call("GET", "/analytics/alerts", { token: (await shop("Elsewhere")).tk })).data.alerts, [], "other tenants' problems never appear");
});

test("quick answers: real numbers, fixed rules, permission-aware, honest about what it can't do", async () => {
  const s = await shop("Ask");
  const beans = (await t.call("POST", "/inventory/ingredients", { token: s.tk, body: { name: "Beans", unit: "G", unitCostRwf: 25, lowStockAt: 100, openingQuantity: 50 } })).data;
  await t.call("PUT", `/inventory/recipes/${s.latte.id}`, { token: s.tk, body: { items: [{ ingredientId: beans.id, quantity: 20 }] } });
  for (const [daysAgo, count] of [[27, 1], [20, 2], [13, 3], [6, 4]]) for (let i = 0; i < count; i++) await s.seed({ items: [{ p: s.latte, q: 1 }, { p: s.cake, q: 1 }], daysAgo, hour: 15 });
  await s.seed({ items: [{ p: s.latte, q: 1 }], daysAgo: 12, hour: 15 });
  await t.call("POST", `/inventory/ingredients/${beans.id}/waste`, { token: s.tk, body: { quantity: 10, reason: "Spill" } });
  const ask = (question, tk = s.tk) => t.call("POST", "/analytics/ask", { token: tk, body: { question } });

  const sales = (await ask("How were sales this week?")).data;
  assert.equal(sales.id, "sales"); assert.match(sales.answer, /Over the last 7 days you took RWF 26,000 from 4 paid orders/); // 4 × (4,000+2,500) = 26,000
  assert.equal(sales.facts[0].value, "RWF 26,000");
  const best = (await ask("what are my best sellers")).data; assert.equal(best.id, "best"); assert.match(best.answer, /Latte \(11 sold/);
  const worst = (await ask("Which products sell poorly?")).data; assert.match(worst.answer, /Tea \(0 sold\)/);
  const peak = (await ask("when are we busiest?")).data; assert.match(peak.answer, /15:00–16:00/);
  const margin = (await ask("Which products have high sales but low margin?")).data; assert.equal(margin.id, "margin");
  assert.match(margin.answer, /only work out margins|margin/);
  const tomorrow = (await ask("what do we expect tomorrow")).data; assert.match(tomorrow.answer, /expect about 3 orders and RWF 16,250/); assert.match(tomorrow.answer, /Beans/); assert.match(tomorrow.answer, /not a guarantee/);
  const promo = (await ask("What should I promote?")).data; assert.match(promo.answer, /Latte \(88% margin/); assert.match(promo.answer, /15:00/);
  const waste = (await ask("what are we wasting")).data; assert.match(waste.answer, /Beans \(RWF 250\)/);
  const stock = (await ask("what's running low?")).data; assert.match(stock.answer, /Beans/);
  const why = (await ask("why were sales lower?")).data; assert.equal(why.id, "why");

  const unknown = (await ask("write me a poem about coffee")).data;
  assert.equal(unknown.id, null); assert.match(unknown.answer, /fixed set of questions/); assert.ok(unknown.suggestions.length >= 8);
  assert.equal((await t.call("POST", "/analytics/ask", { token: s.tk, body: { question: "" } })).status, 400);

  // permissions: each question needs the same permission as its data
  const mkStaff = async (role, email) => { const roles = (await t.call("GET", "/roles", { token: s.tk })).data; const inv = await t.call("POST", "/staff/invitations", { token: s.tk, body: { email, roleId: roles.find((r) => r.name === role).id } }); return (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: role + " Person", password: "Staffpass1" } })).data.token; };
  const waiter = await mkStaff("Waiter", `w${n}@a.rw`), im = await mkStaff("Inventory Manager", `im${n}@a.rw`);
  assert.deepEqual((await t.call("GET", "/analytics/questions", { token: waiter })).data, [], "a waiter has no reports");
  assert.equal((await ask("How were sales this week?", waiter)).status, 403);
  assert.match((await ask("write me a poem", waiter)).data.answer, /don't have access to any reports/);
  assert.deepEqual((await t.call("GET", "/analytics/questions", { token: im })).data.map((q) => q.id).sort(), ["stock", "waste"]);
  assert.equal((await ask("How were sales this week?", im)).status, 403, "inventory staff can't pull sales through the assistant");
  assert.equal((await ask("what are we wasting", im)).status, 200);
  for (const path of ["overview", "forecast", "alerts"]) assert.equal((await t.call("GET", `/analytics/${path}`, { token: waiter })).status, 403);
  assert.equal((await t.call("GET", "/analytics/overview")).status, 401);
  const other = await shop("Ask2");
  assert.match((await ask("How were sales this week?", other.tk)).data.answer, /No paid orders/, "answers only ever use the asking business's own data");
});
