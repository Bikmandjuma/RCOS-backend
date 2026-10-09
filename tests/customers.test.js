import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.js";
import { localParts, priceLines, promoActive, segmentFor } from "../src/shared/promo.js";
import { awardLoyalty } from "../src/modules/customers/customers.service.js";

let t, owner, token, cat, cap, cake, qr;
before(async () => {
  t = await bootstrap("customers");
  owner = await t.registerBusiness({ businessName: "Loyal Cafe" }); token = owner.token;
  await t.call("PATCH", "/tenant", { token, body: { name: "Loyal Cafe", businessType: "CAFE", phone: "0788000000", brandColor: "#155A41", requirePaymentProof: false } });
  cat = (await t.call("POST", "/menu/categories", { token, body: { name: "Coffee" } })).data;
  const food = (await t.call("POST", "/menu/categories", { token, body: { name: "Food" } })).data;
  cap = (await t.call("POST", "/menu/products", { token, body: { categoryId: cat.id, name: "Cappuccino", priceRwf: 3500 } })).data;
  cake = (await t.call("POST", "/menu/products", { token, body: { categoryId: food.id, name: "Cake", priceRwf: 2500 } })).data;
  qr = (await t.call("POST", "/tables", { token, body: { count: 1 } })).data[0].qrToken;
});
after(async () => { await t.close(); });

const place = async (items, { phone, name = "Guest", qrToken = qr } = {}) => {
  const fd = new FormData(); fd.append("data", JSON.stringify({ customerName: name, customerPhone: phone, items, total: 1, discountRwf: 99999 }));
  const r = await t.call("POST", `/public/q/${qrToken}/orders`, { form: fd });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.data, order: await t.prisma.order.findUnique({ where: { publicToken: r.data.orderToken } }) };
};
const pay = (id, tk = token) => t.call("POST", `/orders/${id}/payment`, { token: tk, body: { action: "record", method: "CASH" } });
const status = (id, s) => t.call("PATCH", `/orders/${id}/status`, { token, body: { status: s } });
async function staff(roleName, email) {
  const roles = (await t.call("GET", "/roles", { token })).data;
  const inv = await t.call("POST", "/staff/invitations", { token, body: { email, roleId: roles.find((r) => r.name === roleName).id } });
  return (await t.call("POST", `/auth/invitations/${inv.data.inviteUrl.split("/invite/")[1]}/accept`, { body: { fullName: roleName + " Person", password: "Staffpass1" } })).data.token;
}
const ymdPlus = (n, tz = "Africa/Kigali") => { const d = new Date(`${localParts(tz).ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test("promotion rules: days, time windows (incl. across midnight), dates, category, best-of with no stacking, rounding", () => {
  const base = { isActive: true, percent: 10, categoryId: null, days: null, startTime: null, endTime: null, startDate: null, endDate: null, name: "P" };
  const at = (ymd, dow, hm) => ({ ymd, dow, hm });
  assert.equal(promoActive({ ...base, days: "1,2,3,4,5" }, at("2026-10-08", 4, "10:00")), true);
  assert.equal(promoActive({ ...base, days: "1,2,3,4,5" }, at("2026-10-10", 6, "10:00")), false);
  assert.equal(promoActive({ ...base, startTime: "15:00", endTime: "18:00" }, at("2026-10-08", 4, "17:59")), true);
  assert.equal(promoActive({ ...base, startTime: "15:00", endTime: "18:00" }, at("2026-10-08", 4, "18:00")), false, "end is exclusive");
  assert.equal(promoActive({ ...base, startTime: "22:00", endTime: "02:00" }, at("2026-10-08", 4, "23:30")), true);
  assert.equal(promoActive({ ...base, startTime: "22:00", endTime: "02:00" }, at("2026-10-08", 4, "01:00")), true);
  assert.equal(promoActive({ ...base, startTime: "22:00", endTime: "02:00" }, at("2026-10-08", 4, "12:00")), false);
  assert.equal(promoActive({ ...base, startDate: "2026-10-10" }, at("2026-10-08", 4, "10:00")), false);
  assert.equal(promoActive({ ...base, endDate: "2026-10-08" }, at("2026-10-08", 4, "10:00")), true);
  assert.equal(promoActive({ ...base, isActive: false }, at("2026-10-08", 4, "10:00")), false);
  const lines = [{ unitPriceRwf: 3333, quantity: 1, categoryId: "c1" }, { unitPriceRwf: 1000, quantity: 2, categoryId: "c2" }];
  const r = priceLines(lines, [{ ...base, name: "Ten", percent: 10, categoryId: "c1" }, { ...base, name: "Twenty", percent: 20, categoryId: "c1" }, { ...base, name: "All5", percent: 5 }], at("2026-10-08", 4, "10:00"));
  assert.equal(r.lines[0].discountRwf, Math.floor(3333 * 0.2), "best promotion wins, not stacked");
  assert.equal(r.lines[1].discountRwf, 100, "fallback to the 5% for the other category");
  assert.equal(r.subtotalRwf, 5333); assert.equal(r.totalRwf, 5333 - 666 - 100); assert.deepEqual(r.promotionNames.sort(), ["All5", "Twenty"]);
  assert.equal(segmentFor({ paidOrders: 0, lastPaidAt: null }), "NEW");
  assert.equal(segmentFor({ paidOrders: 2, lastPaidAt: new Date() }), "NEW");
  assert.equal(segmentFor({ paidOrders: 3, lastPaidAt: new Date() }), "REGULAR");
  assert.equal(segmentFor({ paidOrders: 10, lastPaidAt: new Date() }), "VIP");
  assert.equal(segmentFor({ paidOrders: 12, lastPaidAt: new Date(Date.now() - 61 * 86400000) }), "INACTIVE");
});

test("customers are created and matched by phone number, however it's typed", async () => {
  const a = await place([{ productId: cap.id, quantity: 1 }], { phone: "0788 123 456", name: "Jean Claude" });
  const b = await place([{ productId: cap.id, quantity: 1 }], { phone: "+250788123456", name: "J. C." });
  const none = await place([{ productId: cap.id, quantity: 1 }], { name: "Walk In" });
  assert.equal(a.order.customerId, b.order.customerId); assert.ok(a.order.customerId);
  assert.equal(none.order.customerId, null);
  const list = (await t.call("GET", "/customers", { token })).data;
  assert.equal(list.totalCustomers, 1); assert.equal(list.items[0].name, "Jean Claude", "first name is kept");
  assert.equal((await t.call("GET", "/customers?search=788123", { token })).data.total, 1);
  assert.equal((await t.call("GET", "/customers?search=zzz", { token })).data.total, 0);
});

test("server prices promotions: browser-supplied totals are ignored; scope, activity and tenant isolation respected", async () => {
  const dow = localParts("Africa/Kigali").dow;
  const mk = (body, tk = token) => t.call("POST", "/marketing/promotions", { token: tk, body });
  assert.equal((await mk({ name: "Bad", percent: 0 })).status, 400);
  assert.equal((await mk({ name: "Bad", percent: 91 })).status, 400);
  assert.equal((await mk({ name: "Bad", percent: 10, startTime: "15:00" })).status, 400, "needs both times");
  assert.equal((await mk({ name: "Bad", percent: 10, startDate: "2026-10-10", endDate: "2026-10-01" })).status, 400);
  assert.equal((await mk({ name: "Bad", percent: 10, categoryId: "nope" })).status, 400);

  const happy = (await mk({ name: "Coffee 10%", percent: 10, categoryId: cat.id, days: [dow] })).data;
  const later = (await mk({ name: "Not now", percent: 50, categoryId: cat.id, days: [(dow + 1) % 7] })).data;
  const off = (await mk({ name: "Switched off", percent: 40, isActive: false })).data;
  const o = await place([{ productId: cap.id, quantity: 2 }, { productId: cake.id, quantity: 1 }]); // 7000 + 2500
  assert.equal(o.subtotalRwf, 9500); assert.equal(o.discountRwf, 700); assert.equal(o.totalRwf, 8800, "only coffee discounted, 10% of 7000");
  assert.equal(o.order.promotionName, "Coffee 10%"); assert.equal(o.order.discountRwf, 700);

  const info = (await t.call("GET", `/public/q/${qr}`)).data;
  assert.deepEqual(info.promotions.map((p) => p.name), ["Coffee 10%"], "only promotions active right now are shown to guests");
  assert.equal(info.promotions[0].activeNow, true);

  const other = await t.registerBusiness({ businessName: "Other Co" });
  const ocat = (await t.call("POST", "/menu/categories", { token: other.token, body: { name: "Coffee" } })).data;
  const oprod = (await t.call("POST", "/menu/products", { token: other.token, body: { categoryId: ocat.id, name: "Latte", priceRwf: 1000 } })).data;
  const oqr = (await t.call("POST", "/tables", { token: other.token, body: { count: 1 } })).data[0].qrToken;
  await t.call("PATCH", "/tenant", { token: other.token, body: { name: "Other Co", businessType: "CAFE", phone: "0788111111", brandColor: "#155A41", requirePaymentProof: false } });
  const oo = await place([{ productId: oprod.id, quantity: 1 }], { qrToken: oqr });
  assert.equal(oo.discountRwf, 0, "another business's promotions never apply");
  assert.equal((await t.call("GET", "/marketing/promotions", { token: other.token })).data.length, 0);
  assert.equal((await t.call("PATCH", `/marketing/promotions/${happy.id}`, { token: other.token, body: { isActive: false } })).status, 404);

  const upd = await t.call("PATCH", `/marketing/promotions/${happy.id}`, { token, body: { percent: 20 } });
  assert.equal(upd.data.percent, 20); assert.deepEqual(upd.data.days, [dow]);
  assert.equal((await t.call("PATCH", `/marketing/promotions/${happy.id}`, { token, body: { isActive: false } })).data.isActive, false);
  assert.equal((await place([{ productId: cap.id, quantity: 1 }])).discountRwf, 0, "switched off");
  for (const p of [happy, later, off]) await t.call("DELETE", `/marketing/promotions/${p.id}`, { token });
  const rc = (await t.call("GET", `/orders/${o.order.id}`, { token })).data;
  assert.equal(rc.discountRwf, 700); assert.equal(rc.subtotalRwf, 9500);
  await pay(o.order.id);
  const r = (await t.call("GET", `/orders/${o.order.id}/receipt`, { token })).data;
  assert.equal(r.discountRwf, 700); assert.equal(r.promotionName, "Coffee 10%"); assert.equal(r.totalRwf, 8800);
});

test("loyalty: settings validation, points earned once on payment, shown to the guest, reversed on refund, redeemed", async () => {
  assert.equal((await t.call("PUT", "/marketing/loyalty", { token, body: { enabled: true, rwfPerPoint: 100, rewardPoints: 500 } })).status, 400, "reward name required");
  assert.equal((await t.call("PUT", "/marketing/loyalty", { token, body: { enabled: true, rwfPerPoint: 0, rewardPoints: 500, rewardName: "Free coffee" } })).status, 400);
  const before = await place([{ productId: cap.id, quantity: 1 }], { phone: "0788999001", name: "Early Bird" });
  await pay(before.order.id);
  assert.equal((await t.prisma.customer.findFirst({ where: { phoneKey: "788999001" } })).loyaltyPoints, 0, "programme off → no points");

  assert.equal((await t.call("PUT", "/marketing/loyalty", { token, body: { enabled: true, rwfPerPoint: 100, rewardPoints: 100, rewardName: "Free cappuccino" } })).status, 200);
  const o = await place([{ productId: cap.id, quantity: 2 }], { phone: "0788999002", name: "Marie Loyal" }); // 7,000 → 70 pts
  const cust = await t.prisma.customer.findFirst({ where: { phoneKey: "788999002" } });
  assert.equal((await t.call("GET", `/public/orders/${o.orderToken}`)).data.loyalty, undefined, "no points before payment");
  await pay(o.order.id);
  assert.equal((await t.prisma.customer.findUnique({ where: { id: cust.id } })).loyaltyPoints, 70);
  const guest = (await t.call("GET", `/public/orders/${o.orderToken}`)).data;
  assert.deepEqual([guest.loyalty.earned, guest.loyalty.balance, guest.loyalty.rewardPoints, guest.loyalty.rewardName], [70, 70, 100, "Free cappuccino"]);
  assert.equal(guest.customerId, undefined);
  const fresh = await t.prisma.order.findUnique({ where: { id: o.order.id } });
  assert.equal(await awardLoyalty(fresh, (await t.prisma.tenant.findFirst({ where: { slug: owner.user.tenant.slug } }))), 0, "never awarded twice");
  assert.equal((await t.prisma.customer.findUnique({ where: { id: cust.id } })).loyaltyPoints, 70);

  const refund = await t.call("POST", `/orders/${o.order.id}/refund`, { token, body: { amountRwf: 3500, reason: "Cold cup", method: "CASH" } });
  assert.equal(refund.status, 200);
  assert.equal((await t.prisma.customer.findUnique({ where: { id: cust.id } })).loyaltyPoints, 35, "refunded money gives its points back");

  assert.equal((await t.call("POST", `/customers/${cust.id}/redeem`, { token })).status, 409, "35 < 100 points");
  assert.equal((await t.call("POST", `/customers/${cust.id}/points`, { token, body: { points: 100, reason: "Birthday bonus" } })).data.loyaltyPoints, 135);
  assert.equal((await t.call("POST", `/customers/${cust.id}/points`, { token, body: { points: -500, reason: "Oops" } })).status, 409, "can't go below zero");
  assert.equal((await t.call("POST", `/customers/${cust.id}/points`, { token, body: { points: 5, reason: "x" } })).status, 400);
  const red = await t.call("POST", `/customers/${cust.id}/redeem`, { token });
  assert.equal(red.data.loyaltyPoints, 35);
  const detail = (await t.call("GET", `/customers/${cust.id}`, { token })).data;
  assert.deepEqual(detail.loyalty.transactions.map((x) => x.type).sort(), ["ADJUST", "EARN", "REDEEM", "REVERSE"]);
  assert.equal(detail.loyalty.transactions.find((x) => x.type === "REDEEM").note, "Free cappuccino");
  const sums = detail.loyalty.transactions.reduce((n, x) => n + x.points, 0);
  assert.equal(sums, 35, "the history adds up to the balance");
  // a discounted order earns points on what was actually paid
  const dow = localParts("Africa/Kigali").dow;
  const promo = (await t.call("POST", "/marketing/promotions", { token, body: { name: "20 off", percent: 20, days: [dow] } })).data;
  const d = await place([{ productId: cap.id, quantity: 2 }], { phone: "0788999002" }); await pay(d.order.id); // 7000-1400=5600 → 56
  assert.equal((await t.prisma.customer.findUnique({ where: { id: cust.id } })).loyaltyPoints, 35 + 56);
  await t.call("DELETE", `/marketing/promotions/${promo.id}`, { token });
});

test("customers: CRUD, duplicate phones, segments, delete keeps sales records, permissions, isolation", async () => {
  const c = await t.call("POST", "/customers", { token, body: { name: "Phone Booking", phone: "0788777000", email: "pb@example.com", notes: "Allergic to nuts" } });
  assert.equal(c.status, 201);
  assert.equal((await t.call("POST", "/customers", { token, body: { name: "Dup", phone: "+250 788 777 000" } })).status, 409);
  assert.equal((await t.call("POST", "/customers", { token, body: { name: "X" } })).status, 400);
  assert.equal((await t.call("PATCH", `/customers/${c.data.id}`, { token, body: { name: "Phone Booker", phone: "0788777000", notes: "" } })).data.name, "Phone Booker");
  const list = (await t.call("GET", "/customers", { token })).data;
  assert.ok(list.counts.NEW >= 1); assert.equal(typeof list.counts.VIP, "number");
  assert.equal((await t.call("GET", "/customers?segment=VIP", { token })).data.total, 0);

  // delete: personal data goes, the sale stays
  const o = await place([{ productId: cap.id, quantity: 1 }], { phone: "0788777000", name: "Phone Booker" }); await pay(o.order.id);
  assert.equal((await t.call("DELETE", `/customers/${c.data.id}`, { token })).status, 200);
  const kept = await t.prisma.order.findUnique({ where: { id: o.order.id } });
  assert.equal(kept.customerId, null); assert.equal(kept.customerPhone, null); assert.equal(kept.totalRwf, 3500);
  assert.equal((await t.prisma.loyaltyTransaction.count({ where: { customerId: c.data.id } })), 0);

  const cashier = await staff("Cashier", "cash@loyal.rw"); const waiter = await staff("Waiter", "wait@loyal.rw");
  assert.equal((await t.call("GET", "/customers", { token: cashier })).status, 200, "cashiers can look customers up");
  assert.equal((await t.call("POST", "/customers", { token: cashier, body: { name: "Nope" } })).status, 403);
  assert.equal((await t.call("GET", "/customers", { token: waiter })).status, 403);
  const other = await t.registerBusiness();
  assert.equal((await t.call("GET", "/customers", { token: other.token })).data.totalCustomers, 0);
  const mine = (await t.call("GET", "/customers", { token })).data.items[0];
  assert.equal((await t.call("GET", `/customers/${mine.id}`, { token: other.token })).status, 404);
  assert.equal((await t.call("POST", `/customers/${mine.id}/points`, { token: other.token, body: { points: 10, reason: "steal" } })).status, 404);
});

test("reservations: opt-in, validated, confirm/reject flow, guest status & cancel, staff bookings, isolation", async () => {
  const book = (body, slug = owner.user.tenant.slug) => t.call("POST", `/public/restaurants/${slug}/reservations`, { body });
  const tomorrow = ymdPlus(1);
  const ok = { customerName: "Anna Guest", customerPhone: "0788555000", partySize: 4, date: tomorrow, time: "19:00", note: "Birthday" };
  assert.equal((await book(ok)).status, 403, "off by default");
  const putTenant = (extra) => t.call("PATCH", "/tenant", { token, body: { name: "Loyal Cafe", businessType: "CAFE", phone: "0788000000", brandColor: "#155A41", ...extra } });
  await putTenant({ acceptReservations: true, maxPartySize: 8 });
  assert.equal((await t.call("GET", `/public/restaurants/${owner.user.tenant.slug}`)).data.reservations.accepting, true);

  assert.equal((await book({ ...ok, partySize: 9 })).status, 400, "over the party limit");
  assert.equal((await book({ ...ok, date: ymdPlus(-1) })).status, 400, "past date");
  assert.equal((await book({ ...ok, date: ymdPlus(61) })).status, 400, "too far ahead");
  assert.equal((await book({ ...ok, time: "03:00" })).status, 400, "outside opening hours (07:00–21:00)");
  assert.equal((await book({ ...ok, time: "21:00" })).status, 400, "closing time is exclusive");
  assert.equal((await book({ ...ok, customerPhone: "123" })).status, 400);
  assert.equal((await book({ ...ok, partySize: 0 })).status, 400);
  assert.equal((await book(ok, "no-such-place")).status, 404);

  const r = await book(ok); assert.equal(r.status, 201);
  const guest = (await t.call("GET", `/public/reservations/${r.data.token}`)).data;
  assert.equal(guest.status, "PENDING"); assert.equal(guest.restaurant.name, "Loyal Cafe"); assert.equal(guest.customerPhone, undefined);
  assert.equal((await t.prisma.customer.findFirst({ where: { phoneKey: "788555000" } })).name, "Anna Guest");

  const list = (await t.call("GET", `/reservations?date=${tomorrow}`, { token })).data;
  assert.equal(list.items.length, 1); assert.equal(list.pendingCount, 1);
  const id = list.items[0].id;
  const st = (s, extra = {}, tk = token) => t.call("PATCH", `/reservations/${id}/status`, { token: tk, body: { status: s, ...extra } });
  assert.equal((await st("SEATED")).status, 409, "can't skip steps");
  assert.equal((await st("REJECTED")).status, 409, "rejecting needs a reason");
  const conf = await st("CONFIRMED", { tableLabel: "T05" });
  assert.equal(conf.data.status, "CONFIRMED"); assert.equal(conf.data.tableLabel, "T05");
  assert.equal((await t.call("GET", `/public/reservations/${r.data.token}`)).data.status, "CONFIRMED");
  assert.equal((await st("CONFIRMED")).status, 409);

  const waiter = await staff("Waiter", "host@loyal.rw");
  assert.equal((await t.call("GET", `/reservations?date=${tomorrow}`, { token: waiter })).status, 200, "host can view");
  assert.equal((await st("ARRIVED", {}, waiter)).data.status, "ARRIVED", "host can seat guests");
  assert.equal((await t.call("POST", `/public/reservations/${r.data.token}/cancel`)).status, 409, "arrived guests can't cancel online");
  assert.equal((await st("SEATED")).data.status, "SEATED"); assert.equal((await st("COMPLETED")).data.status, "COMPLETED");
  assert.equal((await st("CANCELLED")).status, 409, "completed is final");

  const r2 = await book({ ...ok, customerName: "Ben Cancel", customerPhone: "0788555001", time: "12:30" });
  const cx = await t.call("POST", `/public/reservations/${r2.data.token}/cancel`);
  assert.equal(cx.status, 200);
  assert.equal((await t.call("GET", `/public/reservations/${r2.data.token}`)).data.statusNote, "Cancelled by the guest");
  assert.equal((await t.call("POST", `/public/reservations/${r2.data.token}/cancel`)).status, 409);

  const r3 = await book({ ...ok, customerName: "Cy Reject", customerPhone: "0788555002", time: "13:00" });
  const id3 = (await t.call("GET", `/reservations?date=${tomorrow}`, { token })).data.items.find((x) => x.customerName === "Cy Reject").id;
  const rej = await t.call("PATCH", `/reservations/${id3}/status`, { token, body: { status: "REJECTED", reason: "Fully booked" } });
  assert.equal(rej.data.status, "REJECTED");
  assert.equal((await t.call("GET", `/public/reservations/${r3.data.token}`)).data.statusNote, "Fully booked");

  const phoneBooking = await t.call("POST", "/reservations", { token, body: { customerName: "Walk Up", customerPhone: "0788555003", partySize: 2, date: tomorrow, time: "18:00" } });
  assert.equal(phoneBooking.data.status, "CONFIRMED");
  assert.equal((await t.call("POST", "/reservations", { token: waiter, body: { customerName: "No", customerPhone: "0788555009", partySize: 2, date: tomorrow, time: "18:00" } })).status, 403, "hosts can't create");
  const other = await t.registerBusiness();
  assert.equal((await t.call("GET", `/reservations?date=${tomorrow}`, { token: other.token })).data.items.length, 0);
  assert.equal((await t.call("PATCH", `/reservations/${id}/status`, { token: other.token, body: { status: "CANCELLED" } })).status, 404);
  const dash = (await t.call("GET", "/dashboard/summary", { token })).data;
  assert.equal(typeof dash.reservations.pending, "number");
  await putTenant({ acceptReservations: false });
  assert.equal((await book(ok)).status, 403);
});

test("reviews: only paid & served orders, once each, moderated, shown on the public page", async () => {
  const o = await place([{ productId: cap.id, quantity: 1 }], { name: "Zed Reviewer" });
  const review = (body) => t.call("POST", `/public/orders/${o.orderToken}/review`, { body });
  assert.equal((await review({ rating: 5 })).status, 409, "unpaid");
  await pay(o.order.id);
  assert.equal((await review({ rating: 5 })).status, 409, "not yet served");
  for (const s of ["PREPARING", "READY", "SERVED"]) await status(o.order.id, s);
  assert.equal((await review({ rating: 6 })).status, 400); assert.equal((await review({ rating: 0 })).status, 400); assert.equal((await review({})).status, 400);
  const r = await review({ rating: 4, comment: "Lovely coffee, slow service." });
  assert.equal(r.status, 201);
  assert.equal((await review({ rating: 1 })).status, 409, "once per order");
  assert.deepEqual((await t.call("GET", `/public/orders/${o.orderToken}`)).data.review, { rating: 4, comment: "Lovely coffee, slow service." });

  const pub = (await t.call("GET", `/public/restaurants/${owner.user.tenant.slug}`)).data;
  assert.equal(pub.rating.count, 1); assert.equal(pub.rating.average, 4);
  assert.equal(pub.reviews[0].author, "Zed"); assert.equal(pub.reviews[0].comment, "Lovely coffee, slow service.");
  const staffList = (await t.call("GET", "/reviews", { token })).data;
  assert.equal(staffList.items[0].orderNumber, o.number); assert.equal(staffList.average, 4);
  const waiter = await staff("Waiter", "w2@loyal.rw");
  assert.equal((await t.call("GET", "/reviews", { token: waiter })).status, 403);
  assert.equal((await t.call("PATCH", `/reviews/${staffList.items[0].id}`, { token: waiter, body: { hidden: true } })).status, 403);
  assert.equal((await t.call("PATCH", `/reviews/${staffList.items[0].id}`, { token, body: { hidden: true } })).data.hidden, true);
  const after = (await t.call("GET", `/public/restaurants/${owner.user.tenant.slug}`)).data;
  assert.equal(after.rating, null); assert.equal(after.reviews.length, 0, "hidden reviews leave the public page");
  const other = await t.registerBusiness();
  assert.equal((await t.call("PATCH", `/reviews/${staffList.items[0].id}`, { token: other.token, body: { hidden: false } })).status, 404);
  assert.equal((await t.call("GET", "/reviews", { token: other.token })).data.total, 0);
});

test("audit trail covers customers, loyalty, promotions, reservations and reviews", async () => {
  const logs = (await t.call("GET", "/audit-logs?pageSize=50", { token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs, /Created the promotion "Coffee 10%" \(10% off\)/);
  assert.match(logs, /Loyalty on: 1 point per RWF 100, 100 points = Free cappuccino/);
  assert.match(logs, /Redeemed "Free cappuccino" for Marie Loyal/);
  assert.match(logs, /Adjusted Marie Loyal's points by \+100 \(Birthday bonus\)/);
  assert.match(logs, /Deleted the customer "Phone Booker"/);
  assert.match(logs, /Hid a 4-star review from Zed/);
  const more = (await t.call("GET", "/audit-logs?pageSize=50&page=2", { token })).data.items.map((l) => l.summary).join("\n");
  assert.match(logs + more, /Anna Guest's booking .*confirmed → arrived|Anna Guest's booking/);
});
