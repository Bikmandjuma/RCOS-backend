import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";
import { dayRange, todayYmd } from "../src/shared/time.js";

let t, owner, token, m, qr;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

before(async () => {
  t = await bootstrap("money");
  owner = await t.registerBusiness({ businessName: "Money Cafe" }); token = owner.token;
  const cat = (await t.call("POST", "/menu/categories", { token, body: { name: "Coffee" } })).data;
  const cap = (await t.call("POST", "/menu/products", { token, body: { categoryId: cat.id, name: "Cappuccino", priceRwf: 3500 } })).data;
  const cake = (await t.call("POST", "/menu/products", { token, body: { categoryId: cat.id, name: "Cake", priceRwf: 2500 } })).data;
  const tbl = (await t.call("POST", "/tables", { token, body: { count: 1 } })).data;
  m = { cap, cake }; qr = tbl[0].qrToken;
});
after(async () => { await t.close(); });

async function order(items, { proof = true, qrToken = qr } = {}) {
  const fd = new FormData(); fd.append("data", JSON.stringify({ customerName: "Guest", items }));
  if (proof) fd.append("proof", new Blob([PNG], { type: "image/png" }), "p.png");
  const r = await t.call("POST", `/public/q/${qrToken}/orders`, { form: fd });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return t.prisma.order.findUnique({ where: { publicToken: r.data.orderToken } });
}
async function staff(roleName, email) {
  const roles = (await t.call("GET", "/roles", { token })).data;
  const inv = await t.call("POST", "/staff/invitations", { token, body: { email, roleId: roles.find((r) => r.name === roleName).id } });
  return (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: roleName, password: "Staffpass1" } })).data.token;
}

test("time helpers: business day in Kigali (UTC+2) starts at 22:00 UTC the day before", () => {
  const { start, end } = dayRange("Africa/Kigali", "2026-10-08");
  assert.equal(start.toISOString(), "2026-10-07T22:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-08T22:00:00.000Z");
  assert.match(todayYmd("Africa/Kigali"), /^\d{4}-\d{2}-\d{2}$/);
});

test("confirming a proof stamps method + time; receipts exist only after payment", async () => {
  const o = await order([{ productId: m.cap.id, quantity: 2 }, { productId: m.cake.id, quantity: 1 }]); // 9,500
  assert.equal((await t.call("GET", `/orders/${o.id}/receipt`, { token })).status, 409, "no receipt before payment");
  assert.equal((await t.call("GET", `/public/orders/${o.publicToken}/receipt`)).status, 409);
  assert.equal((await t.call("POST", `/orders/${o.id}/payment`, { token, body: { action: "confirm" } })).data.paymentMethod, "MOBILE_MONEY");
  const r = await t.call("GET", `/orders/${o.id}/receipt`, { token });
  assert.equal(r.status, 200); assert.equal(r.data.receiptNo, `R-${o.number}`);
  assert.equal(r.data.totalRwf, 9500); assert.equal(r.data.netRwf, 9500); assert.equal(r.data.items[0].totalRwf, 7000);
  assert.equal(r.data.business.name, "Money Cafe");
  const g = await t.call("GET", `/public/orders/${o.publicToken}/receipt`);
  assert.equal(g.status, 200); assert.equal(g.data.receiptNo, r.data.receiptNo);
  assert.equal(g.data.customerPhone, undefined);
  const other = await t.registerBusiness();
  assert.equal((await t.call("GET", `/orders/${o.id}/receipt`, { token: other.token })).status, 404, "other business can't read receipts");
});

test("counter payments: record cash for orders that needed no proof; can't double-record", async () => {
  await t.call("PATCH", "/tenant", { token, body: { name: "Money Cafe", businessType: "CAFE", phone: "0788000000", brandColor: "#155A41", requirePaymentProof: false } });
  const o = await order([{ productId: m.cap.id, quantity: 1 }], { proof: false }); // 3,500, NOT_REQUIRED
  assert.equal(o.paymentStatus, "NOT_REQUIRED");
  assert.equal((await t.call("GET", `/orders/${o.id}/receipt`, { token })).status, 409, "unrecorded payment → no receipt yet");
  assert.equal((await t.call("POST", `/orders/${o.id}/payment`, { token, body: { action: "record" } })).status, 400, "method required");
  const waiter = await staff("Waiter", "w@money.rw");
  assert.equal((await t.call("POST", `/orders/${o.id}/payment`, { token: waiter, body: { action: "record", method: "CASH" } })).status, 403);
  const cashier = await staff("Cashier", "c@money.rw");
  const rec = await t.call("POST", `/orders/${o.id}/payment`, { token: cashier, body: { action: "record", method: "CASH" } });
  assert.equal(rec.data.paymentStatus, "CONFIRMED"); assert.equal(rec.data.paymentMethod, "CASH");
  assert.equal((await t.call("POST", `/orders/${o.id}/payment`, { token: cashier, body: { action: "record", method: "CARD" } })).status, 409);
  assert.equal((await t.call("GET", `/orders/${o.id}/receipt`, { token: cashier })).status, 200);
  await t.call("PATCH", "/tenant", { token, body: { name: "Money Cafe", businessType: "CAFE", phone: "0788000000", brandColor: "#155A41", requirePaymentProof: true } });
});

test("refunds: limits, reasons, permissions, and a full audit trail", async () => {
  const o = await order([{ productId: m.cap.id, quantity: 2 }]); // 7,000
  const refund = (tk, body, id = o.id) => t.call("POST", `/orders/${id}/refund`, { token: tk, body });
  assert.equal((await refund(token, { amountRwf: 1000, reason: "Spilled", method: "CASH" })).status, 409, "unpaid orders can't be refunded");
  await t.call("POST", `/orders/${o.id}/payment`, { token, body: { action: "confirm" } });

  const cashier = await staff("Cashier", "c2@money.rw");
  assert.equal((await refund(cashier, { amountRwf: 1000, reason: "Spilled", method: "CASH" })).status, 403, "cashiers can't refund");
  const manager = await staff("Manager", "m@money.rw");
  assert.equal((await refund(manager, { amountRwf: 0, reason: "x", method: "CASH" })).status, 400);
  assert.equal((await refund(manager, { amountRwf: 1000, reason: "", method: "CASH" })).status, 400);
  assert.equal((await refund(manager, { amountRwf: 1000, reason: "Spilled coffee", method: "BITCOIN" })).status, 400);
  assert.equal((await refund(manager, { amountRwf: 7001, reason: "Too much", method: "CASH" })).status, 409);

  const r1 = await refund(manager, { amountRwf: 3500, reason: "One cup was cold", method: "MOBILE_MONEY" });
  assert.equal(r1.status, 200); assert.equal(r1.data.refundedRwf, 3500); assert.equal(r1.data.refunds.length, 1);
  const rc = (await t.call("GET", `/orders/${o.id}/receipt`, { token })).data;
  assert.equal(rc.netRwf, 3500); assert.equal(rc.refunds[0].reason, "One cup was cold");

  // two simultaneous refunds can never exceed what's left
  const [a, b] = await Promise.all([refund(token, { amountRwf: 3000, reason: "Race A", method: "CASH" }), refund(token, { amountRwf: 3000, reason: "Race B", method: "CASH" })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const final = (await t.call("GET", `/orders/${o.id}`, { token })).data;
  assert.equal(final.refundedRwf, 6500); assert.ok(final.refundedRwf <= final.totalRwf);
  assert.equal((await refund(token, { amountRwf: 501, reason: "Over", method: "CASH" })).status, 409);

  const other = await t.registerBusiness();
  assert.equal((await refund(other.token, { amountRwf: 100, reason: "Steal", method: "CASH" })).status, 404, "other business can't refund this order");
  const logs = (await t.call("GET", "/audit-logs?pageSize=50", { token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs, /Refunded RWF 3500 on order #\d+: One cup was cold/);
});

test("daily closing report: sales by method, refunds, net, unpaid, top items; owner-only data", async () => {
  const fresh = await t.registerBusiness({ businessName: "Report Cafe" });
  const tk = fresh.token;
  const cat = (await t.call("POST", "/menu/categories", { token: tk, body: { name: "Drinks" } })).data;
  const p = (await t.call("POST", "/menu/products", { token: tk, body: { categoryId: cat.id, name: "Latte", priceRwf: 4000 } })).data;
  const tq = (await t.call("POST", "/tables", { token: tk, body: { count: 1 } })).data[0].qrToken;
  const mk = async (qty, proof = true) => order([{ productId: p.id, quantity: qty }], { qrToken: tq, proof });
  const o1 = await mk(1), o2 = await mk(2), o3 = await mk(1), o4 = await mk(1);
  await t.call("POST", `/orders/${o1.id}/payment`, { token: tk, body: { action: "confirm" } });   // 4,000 MoMo
  await t.call("POST", `/orders/${o2.id}/payment`, { token: tk, body: { action: "confirm" } });   // 8,000 MoMo
  await t.prisma.order.update({ where: { id: o3.id }, data: { paymentStatus: "NOT_REQUIRED" } });
  await t.call("POST", `/orders/${o3.id}/payment`, { token: tk, body: { action: "record", method: "CASH" } }); // 4,000 cash
  await t.call("POST", `/orders/${o2.id}/refund`, { token: tk, body: { amountRwf: 2000, reason: "Wrong order", method: "CASH" } });
  await t.call("PATCH", `/orders/${o4.id}/status`, { token: tk, body: { status: "CANCELLED", reason: "Left" } });

  const r = await t.call("GET", "/reports/daily", { token: tk });
  assert.equal(r.status, 200);
  assert.equal(r.data.sales.grossRwf, 16000); assert.equal(r.data.sales.orderCount, 3);
  assert.deepEqual(r.data.sales.byMethod.map((x) => [x.method, x.count, x.amountRwf]), [["MOBILE_MONEY", 2, 12000], ["CASH", 1, 4000]]);
  assert.equal(r.data.refunds.amountRwf, 2000); assert.equal(r.data.netRwf, 14000);
  assert.equal(r.data.orders.placed, 4); assert.equal(r.data.orders.cancelled, 1);
  assert.equal(r.data.notYetPaid.count, 0);
  assert.deepEqual(r.data.topItems[0], { name: "Latte", quantity: 4, revenueRwf: 16000 });

  // yesterday is empty; bad dates are refused; reports permission is enforced; tenants are isolated
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  assert.equal((await t.call("GET", `/reports/daily?date=${y}`, { token: tk })).data.sales.grossRwf, 0);
  assert.equal((await t.call("GET", "/reports/daily?date=yesterday", { token: tk })).status, 400);
  const roles = (await t.call("GET", "/roles", { token: tk })).data;
  const inv = await t.call("POST", "/staff/invitations", { token: tk, body: { email: "w@report.rw", roleId: roles.find((x) => x.name === "Waiter").id } });
  const w = (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: "Wally", password: "Staffpass1" } })).data.token;
  assert.equal((await t.call("GET", "/reports/daily", { token: w })).status, 403);
  assert.equal((await t.call("GET", "/reports/daily", { token })).data.sales.byMethod.every((x) => x.amountRwf !== 12000), true, "another business's numbers never leak");
});
