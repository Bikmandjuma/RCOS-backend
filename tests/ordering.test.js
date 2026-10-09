import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { bootstrap } from "./helpers.js";

let t, owner, token;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

before(async () => { t = await bootstrap("ordering"); owner = await t.registerBusiness({ businessName: "Order Cafe" }); token = owner.token; });
after(async () => { await t.close(); });

const png = () => new Blob([PNG], { type: "image/png" });
async function setupMenu(tk = token) {
  const cat = (await t.call("POST", "/menu/categories", { token: tk, body: { name: "Coffee" } })).data;
  const cap = (await t.call("POST", "/menu/products", { token: tk, body: { categoryId: cat.id, name: "Cappuccino", priceRwf: 3500 } })).data;
  const cake = (await t.call("POST", "/menu/products", { token: tk, body: { categoryId: cat.id, name: "Chocolate cake", priceRwf: 2500 } })).data;
  const tbl = (await t.call("POST", "/tables", { token: tk, body: { prefix: "T", count: 2 } })).data;
  return { cat, cap, cake, tables: tbl };
}
async function placeOrder(qr, data, withProof = true) {
  const fd = new FormData(); fd.append("data", JSON.stringify(data));
  if (withProof) fd.append("proof", png(), "proof.png");
  return t.call("POST", `/public/q/${qr}/orders`, { form: fd });
}
async function staff(roleName, email) {
  const roles = (await t.call("GET", "/roles", { token })).data;
  const inv = await t.call("POST", "/staff/invitations", { token, body: { email, roleId: roles.find((r) => r.name === roleName).id } });
  const acc = await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: roleName, password: "Staffpass1" } });
  return acc.data.token;
}

let m, qr;
test("menu: categories, items, validation and availability", async () => {
  m = await setupMenu(); qr = m.tables[0].qrToken;
  assert.equal(m.tables.map((x) => x.label).join(), "T01,T02");
  assert.match(qr, /^[A-Z2-9]{8}$/);
  assert.equal((await t.call("POST", "/menu/categories", { token, body: { name: "Coffee" } })).status, 409);
  assert.equal((await t.call("POST", "/menu/products", { token, body: { categoryId: m.cat.id, name: "Bad", priceRwf: 0 } })).status, 400);
  assert.equal((await t.call("POST", "/menu/products", { token, body: { categoryId: m.cat.id, name: "Bad", priceRwf: 12.5 } })).status, 400);
  assert.equal((await t.call("POST", "/tables", { token, body: { prefix: "T", count: 2 } })).status, 409, "duplicate labels refused");
  const full = (await t.call("GET", "/menu", { token })).data;
  assert.equal(full[0].products.length, 2);
  assert.equal((await t.call("DELETE", `/menu/categories/${m.cat.id}`, { token })).status, 409, "non-empty category kept");
});

test("scanning a QR resolves restaurant, table and menu — and shows unavailable items", async () => {
  await t.call("PATCH", `/menu/products/${m.cake.id}`, { token, body: { isAvailable: false } });
  const r = await t.call("GET", `/public/q/${qr.toLowerCase()}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.restaurant.name, "Order Cafe"); assert.equal(r.data.table.label, "T01");
  assert.equal(r.data.acceptingOrders, true); assert.equal(r.data.requireProof, true);
  assert.equal(r.data.menu[0].products.find((p) => p.name === "Chocolate cake").isAvailable, false);
  assert.equal(r.data.restaurant.id, undefined);
  assert.equal((await t.call("GET", "/public/q/NOSUCHQR")).status, 404);
  await t.call("PATCH", `/menu/products/${m.cake.id}`, { token, body: { isAvailable: true } });
});

test("placing an order: server prices it, proof is mandatory, bad files and unavailable items are refused", async () => {
  const items = [{ productId: m.cap.id, quantity: 2 }, { productId: m.cake.id, quantity: 1 }];
  const noProof = await placeOrder(qr, { customerName: "Jean", items }, false);
  assert.equal(noProof.status, 400); assert.match(noProof.body.message, /payment proof/i);

  const fd = new FormData(); fd.append("data", JSON.stringify({ customerName: "Jean", items })); fd.append("proof", new Blob(["<script>x</script>"], { type: "image/png" }), "x.png");
  assert.equal((await t.call("POST", `/public/q/${qr}/orders`, { form: fd })).status, 400, "non-image refused");

  // a client claiming its own price is ignored: total comes from the database
  const o = await placeOrder(qr, { customerName: "Jean", items: items.map((i) => ({ ...i, price: 1 })), total: 1 });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  assert.equal(o.data.totalRwf, 2 * 3500 + 2500);
  assert.equal(o.data.number, 1001);
  assert.equal((await placeOrder(qr, { customerName: "Marie", items: [items[0]] })).data.number, 1002);

  await t.call("PATCH", `/menu/products/${m.cake.id}`, { token, body: { isAvailable: false } });
  const gone = await placeOrder(qr, { customerName: "Jean", items });
  assert.equal(gone.status, 409); assert.match(gone.body.message, /Chocolate cake/);
  await t.call("PATCH", `/menu/products/${m.cake.id}`, { token, body: { isAvailable: true } });

  assert.equal((await placeOrder(qr, { customerName: "J", items })).status, 400);
  assert.equal((await placeOrder(qr, { customerName: "Jean", items: [{ productId: m.cap.id, quantity: 99 }] })).status, 400);
  assert.equal((await placeOrder(qr, { customerName: "Jean", items: [{ productId: "nope", quantity: 1 }] })).status, 409);
});

test("a table can't order from another business's menu", async () => {
  const other = await t.registerBusiness({ businessName: "Other Cafe" });
  const om = await setupMenu(other.token);
  const steal = await placeOrder(om.tables[0].qrToken, { customerName: "Sneaky", items: [{ productId: m.cap.id, quantity: 1 }] });
  assert.equal(steal.status, 409, "product from tenant A is invisible to tenant B's table");
  const orders = (await t.call("GET", "/orders?view=active", { token: other.token })).data;
  assert.equal(orders.total, 0);
  assert.equal((await t.call("GET", "/orders?view=active", { token })).data.total, 2);
});

test("staff: payment review gates the kitchen, proof is private, guest can replace a rejected proof", async () => {
  const list = (await t.call("GET", "/orders?view=review", { token })).data;
  assert.equal(list.total, 2); assert.equal(list.counts.review, 2);
  const id = list.items[0].id;

  // kitchen can't start an unpaid order
  const early = await t.call("PATCH", `/orders/${id}/status`, { token, body: { status: "PREPARING" } });
  assert.equal(early.status, 409); assert.equal(early.body.code, "PAYMENT_NOT_CONFIRMED");
  assert.equal((await t.call("GET", "/orders/kitchen", { token })).data.length, 0, "unpaid orders are not on the kitchen screen");

  // proof is only for signed-in staff of this business
  const proof = await fetch(`${t.base}/orders/${id}/proof`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(proof.status, 200); assert.equal(proof.headers.get("cache-control"), "private, no-store");
  assert.equal((await fetch(`${t.base}/orders/${id}/proof`)).status, 401);
  const other = await t.registerBusiness();
  assert.equal((await fetch(`${t.base}/orders/${id}/proof`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await fetch(`${t.base.replace("/api/v1", "")}/uploads/tenants/x/proofs/y.png`)).status, 404, "never served statically");

  // reject → guest sees reason and re-uploads
  assert.equal((await t.call("POST", `/orders/${id}/payment`, { token, body: { action: "reject" } })).status, 400, "reason required");
  const rej = await t.call("POST", `/orders/${id}/payment`, { token, body: { action: "reject", reason: "Amount is too low" } });
  assert.equal(rej.data.paymentStatus, "REJECTED");
  assert.equal((await t.call("POST", `/orders/${id}/payment`, { token, body: { action: "confirm" } })).status, 409, "already reviewed");
  const order = (await t.call("GET", `/orders/${id}`, { token })).data;
  const guest = await t.call("GET", `/public/orders/${(await t.prisma.order.findUnique({ where: { id } })).publicToken}`);
  assert.equal(guest.data.paymentStatus, "REJECTED"); assert.equal(guest.data.paymentNote, "Amount is too low");
  assert.equal(guest.data.customerPhone, null); assert.equal(guest.data.id, undefined);
  const tok = (await t.prisma.order.findUnique({ where: { id } })).publicToken;
  const fd = new FormData(); fd.append("proof", png(), "p2.png");
  assert.equal((await t.call("POST", `/public/orders/${tok}/proof`, { form: fd })).status, 200);
  assert.equal((await t.call("GET", `/orders/${id}`, { token })).data.paymentStatus, "PROOF_SUBMITTED");
  const again = new FormData(); again.append("proof", png(), "p3.png");
  assert.equal((await t.call("POST", `/public/orders/${tok}/proof`, { form: again })).status, 409, "only a rejected proof can be replaced");

  // confirm → kitchen sees it
  assert.equal((await t.call("POST", `/orders/${id}/payment`, { token, body: { action: "confirm" } })).data.paymentStatus, "CONFIRMED");
  assert.equal((await t.call("GET", "/orders/kitchen", { token })).data.length, 1);
  assert.equal(order.items.length, 2);
});

test("order lifecycle and who may do what", async () => {
  const kitchen = await staff("Kitchen", "k@example.com");
  const waiter = await staff("Waiter", "w@example.com");
  const cashier = await staff("Cashier", "c@example.com");
  const kList = await t.call("GET", "/orders/kitchen", { token: kitchen });
  assert.equal(kList.status, 200); const id = kList.data[0].id;

  assert.equal((await t.call("POST", `/orders/${id}/payment`, { token: kitchen, body: { action: "confirm" } })).status, 403, "kitchen can't review payments");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: kitchen, body: { status: "READY" } })).status, 409, "no skipping steps");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: kitchen, body: { status: "PREPARING" } })).data.status, "PREPARING");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: kitchen, body: { status: "READY" } })).data.status, "READY");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: kitchen, body: { status: "SERVED" } })).status, 403, "kitchen can't serve");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: waiter, body: { status: "SERVED" } })).data.status, "SERVED");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: waiter, body: { status: "CANCELLED" } })).status, 403, "waiter can't cancel");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token: waiter, body: { status: "COMPLETED" } })).data.status, "COMPLETED");
  assert.equal((await t.call("PATCH", `/orders/${id}/status`, { token, body: { status: "CANCELLED" } })).status, 409, "completed orders are final");
  const hist = (await t.call("GET", `/orders/${id}`, { token })).data.history.map((h) => h.to);
  assert.deepEqual(hist, ["PLACED", "PREPARING", "READY", "SERVED", "COMPLETED"]);

  // cashier confirms payment on the other order; owner cancels it with a reason
  const review = (await t.call("GET", "/orders?view=review", { token: cashier })).data.items[0];
  assert.equal((await t.call("POST", `/orders/${review.id}/payment`, { token: cashier, body: { action: "confirm" } })).status, 200);
  assert.equal((await t.call("POST", `/orders/${review.id}/payment`, { token: waiter, body: { action: "confirm" } })).status, 403);
  const c = await t.call("PATCH", `/orders/${review.id}/status`, { token, body: { status: "CANCELLED", reason: "Guest left" } });
  assert.equal(c.data.cancelReason, "Guest left");
  const done = (await t.call("GET", "/orders?view=done", { token })).data;
  assert.equal(done.total, 2);
});

test("audit trail covers payments, cancellations and menu changes", async () => {
  const logs = (await t.call("GET", "/audit-logs?pageSize=50", { token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs, /Rejected payment proof for order #1001: Amount is too low/);
  assert.match(logs, /Confirmed payment for order #1001/);
  assert.match(logs, /Cancelled order #1002: Guest left/);
  assert.match(logs, /"Chocolate cake": marked unavailable/);
});

test("live stream delivers events to signed-in staff only", async () => {
  assert.equal((await fetch(`${t.base}/orders/stream`)).status, 401);
  const ac = new AbortController();
  const res = await fetch(`${t.base}/orders/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let seen = ""; const read = (async () => { while (!/order\.created/.test(seen)) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); } })();
  await new Promise((r) => setTimeout(r, 150));
  await placeOrder(qr, { customerName: "Live", items: [{ productId: m.cap.id, quantity: 1 }] });
  await Promise.race([read, new Promise((r) => setTimeout(r, 3000))]);
  ac.abort();
  assert.match(seen, /order\.created/);
  const other = await t.registerBusiness();
  const ac2 = new AbortController(); const r2 = await fetch(`${t.base}/orders/stream`, { headers: { Authorization: `Bearer ${other.token}` }, signal: ac2.signal });
  const rd2 = r2.body.getReader(); await new Promise((r) => setTimeout(r, 150));
  await placeOrder(qr, { customerName: "Live2", items: [{ productId: m.cap.id, quantity: 1 }] });
  const got = await Promise.race([rd2.read().then(({ value }) => new TextDecoder().decode(value)), new Promise((r) => setTimeout(() => r("timeout"), 700))]);
  ac2.abort();
  assert.ok(!/order\.created/.test(got), "another business never receives these events");
});

test("proof optional mode, paused ordering when plan expired, table off/delete rules, dashboard", async () => {
  await t.call("PATCH", "/tenant", { token, body: { name: "Order Cafe", businessType: "CAFE", phone: "0788000000", brandColor: "#155A41", requirePaymentProof: false, paymentInstructions: "MTN MoMo 0788 000 000 (Order Cafe)" } });
  const info = (await t.call("GET", `/public/q/${qr}`)).data;
  assert.equal(info.requireProof, false); assert.match(info.paymentInstructions, /MoMo/);
  const free = await placeOrder(qr, { customerName: "Walkin", items: [{ productId: m.cap.id, quantity: 1 }] }, false);
  assert.equal(free.status, 201);
  const o = await t.prisma.order.findUnique({ where: { publicToken: free.data.orderToken } });
  assert.equal(o.paymentStatus, "NOT_REQUIRED");
  assert.equal((await t.call("PATCH", `/orders/${o.id}/status`, { token, body: { status: "PREPARING" } })).data.status, "PREPARING", "no proof needed → straight to the kitchen");

  assert.equal((await t.call("DELETE", `/tables/${m.tables[0].id}`, { token })).status, 409, "table with orders can't be deleted");
  await t.call("PATCH", `/tables/${m.tables[1].id}`, { token, body: { isActive: false } });
  assert.equal((await t.call("GET", `/public/q/${m.tables[1].qrToken}`)).data.acceptingOrders, false);
  assert.equal((await placeOrder(m.tables[1].qrToken, { customerName: "Off", items: [{ productId: m.cap.id, quantity: 1 }] })).status, 403);
  assert.equal((await t.call("DELETE", `/tables/${m.tables[1].id}`, { token })).status, 200);

  const dash = (await t.call("GET", "/dashboard/summary", { token })).data;
  assert.ok(dash.today.orders >= 4); assert.ok(dash.today.confirmedRevenueRwf > 0);
  assert.equal(dash.checklist.find((c) => c.key === "menu").done, true);
  assert.equal(dash.checklist.find((c) => c.key === "order").done, true);

  await t.prisma.subscription.update({ where: { tenantId: owner.user.tenant.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
  const paused = await t.call("GET", `/public/q/${qr}`);
  assert.equal(paused.data.acceptingOrders, false);
  assert.equal((await placeOrder(qr, { customerName: "Late", items: [{ productId: m.cap.id, quantity: 1 }] })).status, 403);
  assert.equal((await t.call("PATCH", `/orders/${o.id}/status`, { token, body: { status: "READY" } })).status, 402);
  const dir = "private-uploads"; assert.ok(fs.existsSync(dir), "proofs live in the private folder");
});
