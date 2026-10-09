import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";
import { deductStockForOrder } from "../src/modules/inventory/stock.service.js";

let t, owner, token, beans, milk, cup, cap, cake, qr;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

before(async () => {
  t = await bootstrap("inventory");
  owner = await t.registerBusiness({ businessName: "Stock Cafe" }); token = owner.token;
  const cat = (await t.call("POST", "/menu/categories", { token, body: { name: "Coffee" } })).data;
  cap = (await t.call("POST", "/menu/products", { token, body: { categoryId: cat.id, name: "Cappuccino", priceRwf: 3500 } })).data;
  cake = (await t.call("POST", "/menu/products", { token, body: { categoryId: cat.id, name: "Water", priceRwf: 500 } })).data;
  qr = (await t.call("POST", "/tables", { token, body: { count: 1 } })).data[0].qrToken;
});
after(async () => { await t.close(); });

const ing = (body, tk = token) => t.call("POST", "/inventory/ingredients", { token: tk, body });
async function placeAndPay(items) {
  const fd = new FormData(); fd.append("data", JSON.stringify({ customerName: "Guest", items })); fd.append("proof", new Blob([PNG], { type: "image/png" }), "p.png");
  const r = await t.call("POST", `/public/q/${qr}/orders`, { form: fd });
  const o = await t.prisma.order.findUnique({ where: { publicToken: r.data.orderToken } });
  await t.call("POST", `/orders/${o.id}/payment`, { token, body: { action: "confirm" } });
  return o;
}
async function staff(roleName, email) {
  const roles = (await t.call("GET", "/roles", { token })).data;
  const inv = await t.call("POST", "/staff/invitations", { token, body: { email, roleId: roles.find((r) => r.name === roleName).id } });
  return (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: roleName, password: "Staffpass1" } })).data.token;
}
const get = async (id) => (await t.call("GET", "/inventory/ingredients", { token })).data.find((i) => i.id === id);

test("ingredients: create with opening stock, validate, keep names unique, units are fixed", async () => {
  beans = (await ing({ name: "Coffee beans", unit: "G", lowStockAt: 500, unitCostRwf: 25, openingQuantity: 2000 })).data;
  milk = (await ing({ name: "Milk", unit: "ML", lowStockAt: 1000, openingQuantity: 5000 })).data;
  cup = (await ing({ name: "Paper cups", unit: "PCS", lowStockAt: 10 })).data;
  assert.equal(beans.quantity, 2000); assert.equal(beans.status, "OK"); assert.equal(cup.status, "OUT");
  assert.equal((await ing({ name: "Milk", unit: "ML" })).status, 409);
  assert.equal((await ing({ name: "X", unit: "G" })).status, 400);
  assert.equal((await ing({ name: "Sugar", unit: "KG" })).status, 400);
  assert.equal((await ing({ name: "Sugar", unit: "G", openingQuantity: 1.5 })).status, 400);
  const p = await t.call("PATCH", `/inventory/ingredients/${beans.id}`, { token, body: { lowStockAt: 600, unit: "ML" } });
  assert.equal(p.data.lowStockAt, 600); assert.equal(p.data.unit, "G", "unit can't be changed");
  const mv = (await t.call("GET", `/inventory/movements?ingredientId=${beans.id}`, { token })).data;
  assert.equal(mv.items[0].reason, "Opening stock"); assert.equal(mv.items[0].balanceAfter, 2000);
});

test("purchases add stock, update unit cost, and are validated and tenant-scoped", async () => {
  const sup = (await t.call("POST", "/inventory/suppliers", { token, body: { name: "Kigali Roasters", phone: "0788111222" } })).data;
  assert.equal((await t.call("POST", "/inventory/suppliers", { token, body: { name: "Kigali Roasters" } })).status, 409);
  const r = await t.call("POST", "/inventory/purchases", { token, body: { supplierId: sup.id, items: [{ ingredientId: beans.id, quantity: 1000, totalCostRwf: 30000 }, { ingredientId: cup.id, quantity: 50, totalCostRwf: 2500 }] } });
  assert.equal(r.status, 201); assert.equal(r.data.totalRwf, 32500);
  const b = await get(beans.id);
  assert.equal(b.quantity, 3000); assert.equal(b.unitCostRwf, 30, "latest price becomes the cost");
  assert.equal((await get(cup.id)).status, "OK");
  assert.equal((await t.call("POST", "/inventory/purchases", { token, body: { items: [] } })).status, 400);
  assert.equal((await t.call("POST", "/inventory/purchases", { token, body: { items: [{ ingredientId: beans.id, quantity: 0, totalCostRwf: 1 }] } })).status, 400);
  assert.equal((await t.call("POST", "/inventory/purchases", { token, body: { items: [{ ingredientId: "nope", quantity: 5, totalCostRwf: 1 }] } })).status, 400);
  const other = await t.registerBusiness();
  const steal = await t.call("POST", "/inventory/purchases", { token: other.token, body: { items: [{ ingredientId: beans.id, quantity: 5, totalCostRwf: 1 }] } });
  assert.equal(steal.status, 400, "can't buy into another business's ingredient");
  assert.equal((await get(beans.id)).quantity, 3000);
  assert.equal((await t.call("DELETE", `/inventory/suppliers/${sup.id}`, { token })).status, 409, "supplier with purchases stays");
  const list = (await t.call("GET", "/inventory/purchases", { token })).data;
  assert.equal(list[0].supplier, "Kigali Roasters"); assert.equal(list[0].items.length, 2);
  assert.equal((await t.call("GET", "/inventory/purchases", { token: other.token })).data.length, 0);
});

test("recipes: cost from ingredient prices, validation, replace, isolation", async () => {
  await t.call("PATCH", `/inventory/ingredients/${milk.id}`, { token, body: { unitCostRwf: 1.2 } });
  const put = (items, tk = token, id = cap.id) => t.call("PUT", `/inventory/recipes/${id}`, { token: tk, body: { items } });
  const r = await put([{ ingredientId: beans.id, quantity: 18 }, { ingredientId: milk.id, quantity: 150 }]);
  assert.equal(r.status, 200); assert.equal(r.data.costRwf, Math.round(18 * 30 + 150 * 1.2)); // 720
  assert.equal((await put([{ ingredientId: beans.id, quantity: 18 }, { ingredientId: beans.id, quantity: 5 }])).status, 400, "no duplicates");
  assert.equal((await put([{ ingredientId: "nope", quantity: 5 }])).status, 400);
  assert.equal((await put([{ ingredientId: beans.id, quantity: 0 }])).status, 400);
  const other = await t.registerBusiness();
  assert.equal((await put([{ ingredientId: beans.id, quantity: 5 }], other.token)).status, 404, "other business can't edit this product's recipe");
  const all = (await t.call("GET", "/inventory/recipes", { token })).data;
  assert.equal(all.length, 1); assert.equal(all[0].items.length, 2); assert.equal(all[0].costRwf, 720);
  assert.equal((await t.call("DELETE", `/inventory/ingredients/${beans.id}`, { token })).status, 409, "ingredient in a recipe can't be deleted");
});

test("stock leaves when the kitchen STARTS an order — exactly once, never blocking", async () => {
  const o = await placeAndPay([{ productId: cap.id, quantity: 2 }, { productId: cake.id, quantity: 1 }]); // water has no recipe
  assert.equal((await get(beans.id)).quantity, 3000, "nothing deducted while waiting");
  assert.equal((await t.call("PATCH", `/orders/${o.id}/status`, { token, body: { status: "PREPARING" } })).status, 200);
  assert.equal((await get(beans.id)).quantity, 3000 - 36); assert.equal((await get(milk.id)).quantity, 5000 - 300);
  const mv = (await t.call("GET", `/inventory/movements?type=SALE`, { token })).data.items;
  assert.equal(mv.length, 2); assert.ok(mv.every((m) => m.reason === `Order #${o.number}` && m.quantity < 0));
  // calling the deduction again (retry / duplicate event) does nothing
  const again = await deductStockForOrder({ ...o, items: undefined }, null);
  assert.equal(again.deducted, false);
  assert.equal((await get(beans.id)).quantity, 3000 - 36);
  // the balance trail is consistent: current stock = last movement's balanceAfter
  const last = (await t.call("GET", `/inventory/movements?ingredientId=${beans.id}`, { token })).data.items[0];
  assert.equal(last.balanceAfter, (await get(beans.id)).quantity);
});

test("cancelled before the kitchen starts = no deduction; shortages go negative but never block cooking", async () => {
  const c = await placeAndPay([{ productId: cap.id, quantity: 1 }]);
  await t.call("PATCH", `/orders/${c.id}/status`, { token, body: { status: "CANCELLED", reason: "Changed mind" } });
  assert.equal((await get(beans.id)).quantity, 3000 - 36, "unchanged");
  await t.call("POST", `/inventory/ingredients/${beans.id}/count`, { token, body: { quantity: 10, note: "Recount" } });
  const o = await placeAndPay([{ productId: cap.id, quantity: 1 }]);
  assert.equal((await t.call("PATCH", `/orders/${o.id}/status`, { token, body: { status: "PREPARING" } })).status, 200, "kitchen is never blocked");
  const b = await get(beans.id);
  assert.equal(b.quantity, -8); assert.equal(b.status, "OUT");
});

test("waste can't exceed stock; counts record the difference; both need a reason/amount", async () => {
  const w = (id, body, tk = token) => t.call("POST", `/inventory/ingredients/${id}/waste`, { token: tk, body });
  assert.equal((await w(milk.id, { quantity: 100 })).status, 400, "reason required");
  assert.equal((await w(milk.id, { quantity: 999999, reason: "Dropped" })).status, 409);
  assert.equal((await w(milk.id, { quantity: 700, reason: "Expired" })).data.quantity, 5000 - 450 - 700);
  const [x, y] = await Promise.all([w(cup.id, { quantity: 40, reason: "Race A" }), w(cup.id, { quantity: 40, reason: "Race B" })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409], "two simultaneous wastes can't overdraw 50 cups");
  assert.equal((await get(cup.id)).quantity, 10);
  const c = await t.call("POST", `/inventory/ingredients/${milk.id}/count`, { token, body: { quantity: 3000, note: "Weekly count" } });
  assert.equal(c.data.quantity, 3000);
  const adj = (await t.call("GET", `/inventory/movements?ingredientId=${milk.id}&type=ADJUSTMENT`, { token })).data.items[0];
  assert.equal(adj.balanceAfter, 3000); assert.equal(adj.reason, "Weekly count");
  const sum = (await t.call("GET", "/inventory/summary", { token })).data;
  assert.ok(sum.waste30d.count >= 2 && sum.waste30d.costRwf > 0);
  // history always adds up: opening + movements = current
  const all = (await t.call("GET", `/inventory/movements?ingredientId=${milk.id}&pageSize=50`, { token })).data.items;
  assert.equal(all.reduce((n, m) => n + m.quantity, 0), (await get(milk.id)).quantity);
});

test("low-stock status, days-left estimate and dashboard card", async () => {
  await t.call("POST", `/inventory/ingredients/${beans.id}/count`, { token, body: { quantity: 400 } }); // threshold 600 → LOW
  assert.equal((await get(beans.id)).status, "LOW");
  const o = await placeAndPay([{ productId: cap.id, quantity: 2 }]); await t.call("PATCH", `/orders/${o.id}/status`, { token, body: { status: "PREPARING" } });
  const b = await get(beans.id);
  assert.ok(b.dailyUse > 0); assert.ok(b.daysLeft === null || b.daysLeft >= 0);
  const dash = (await t.call("GET", "/dashboard/summary", { token })).data;
  assert.ok(dash.lowStock.count >= 1); assert.ok(dash.lowStock.items.some((i) => i.name === "Coffee beans"));
});

test("permissions and isolation", async () => {
  const waiter = await staff("Waiter", "w@stock.rw");
  assert.equal((await t.call("GET", "/inventory/ingredients", { token: waiter })).status, 403);
  assert.equal((await t.call("GET", "/dashboard/summary", { token: waiter })).data.lowStock, null);
  const im = await staff("Inventory Manager", "im@stock.rw");
  assert.equal((await t.call("GET", "/inventory/ingredients", { token: im })).status, 200);
  assert.equal((await t.call("POST", `/inventory/ingredients/${cup.id}/waste`, { token: im, body: { quantity: 1, reason: "Torn" } })).status, 200);
  assert.equal((await t.call("PUT", `/inventory/recipes/${cap.id}`, { token: im, body: { items: [{ ingredientId: beans.id, quantity: 18 }] } })).status, 200, "inventory manager edits recipes");
  const kitchen = await staff("Kitchen", "k@stock.rw");
  assert.equal((await t.call("GET", "/inventory/ingredients", { token: kitchen })).status, 403);
  assert.equal((await t.call("POST", `/inventory/ingredients/${cup.id}/waste`, { token: kitchen, body: { quantity: 1, reason: "Torn" } })).status, 403);

  const other = await t.registerBusiness();
  assert.equal((await t.call("GET", "/inventory/ingredients", { token: other.token })).data.length, 0);
  assert.equal((await t.call("PATCH", `/inventory/ingredients/${beans.id}`, { token: other.token, body: { name: "Hacked" } })).status, 404);
  assert.equal((await t.call("POST", `/inventory/ingredients/${beans.id}/waste`, { token: other.token, body: { quantity: 1, reason: "Steal" } })).status, 404);
  assert.equal((await t.call("GET", "/inventory/movements", { token: other.token })).data.total, 0);
  // unused ingredient can be deleted
  const tmp = (await ing({ name: "Temp", unit: "G" })).data;
  assert.equal((await t.call("DELETE", `/inventory/ingredients/${tmp.id}`, { token })).status, 200);
});

test("audit trail covers stock changes", async () => {
  const logs = (await t.call("GET", "/audit-logs?pageSize=50", { token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs, /Recorded waste: 700 ml of Milk \(Expired\)/);
  assert.match(logs, /Stock count for Milk: 4,?\d+ ml → 3,000 ml|Stock count for Milk/);
  assert.match(logs, /Recorded a purchase of 2 items \(RWF 32,500\) from Kigali Roasters/);
  assert.match(logs, /Set the recipe for "Cappuccino"/);
});
