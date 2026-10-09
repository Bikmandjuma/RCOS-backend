// Optional: fills a fresh database with a realistic demo business so every screen has something to show.
//   npm run db:demo
// Safe to run twice (it stops if the demo already exists). Development only unless DEMO_PASSWORD is set.
import "dotenv/config";
import crypto from "node:crypto";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/shared/db.js";
import { ensurePlans } from "../src/modules/billing/plans.js";

const PASSWORD = process.env.DEMO_PASSWORD || (env.isProd ? "" : "Demo#12345678");
if (!PASSWORD) { console.error("Refusing to create demo accounts in production without DEMO_PASSWORD."); process.exit(1); }
const OWNER = "demo@restaurantos.local";
if (await prisma.user.findUnique({ where: { email: OWNER } })) { console.log("The demo business already exists. Sign in as", OWNER); await prisma.$disconnect(); process.exit(0); }

await ensurePlans();
const server = createApp().listen(0); await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, token, body, form) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${json.message || res.status}`);
  return json.data;
};
const rand = (() => { let a = 20261009; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const pick = (arr, weights) => { const total = weights ? weights.reduce((x, y) => x + y, 0) : arr.length; let r = rand() * total; for (let i = 0; i < arr.length; i++) { r -= weights ? weights[i] : 1; if (r <= 0) return arr[i]; } return arr.at(-1); };
const TZ = "Africa/Kigali";
const ymd = (offset = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offset * 86_400_000));
const at = (daysAgo, hour, minute) => { const [y, m, d] = ymd(-daysAgo).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, hour - 2, minute)); }; // Kigali is UTC+2

try {
  // ---- the business ----
  const reg = await call("POST", "/auth/register", null, { businessName: "Demo Café", businessType: "CAFE", phone: "0788000000", fullName: "Demo Owner", email: OWNER, password: PASSWORD, planCode: "monthly", acceptTerms: true });
  const tk = reg.token, tenantId = reg.user.tenant.id, slug = reg.user.tenant.slug;
  await call("PATCH", "/tenant", tk, { name: "Demo Café", businessType: "CAFE", phone: "0788000000", city: "Kigali", address: "KG 7 Ave, Kimihurura", description: "Specialty coffee, fresh bakes and good company.", brandColor: "#155A41", paymentInstructions: "MTN MoMo: dial *182*8*1*123456#\nName: Demo Café", requirePaymentProof: false, acceptReservations: true, maxPartySize: 10 });

  // ---- menu ----
  const cat = async (name) => call("POST", "/menu/categories", tk, { name });
  const [coffee, food, juice] = [await cat("Coffee"), await cat("Food"), await cat("Juice")];
  const item = (categoryId, name, priceRwf, description) => call("POST", "/menu/products", tk, { categoryId, name, priceRwf, description });
  const espresso = await item(coffee.id, "Espresso", 1500, "Single shot, Rwandan beans");
  const cappuccino = await item(coffee.id, "Cappuccino", 2500, "Espresso, steamed milk, light foam");
  const latte = await item(coffee.id, "Latte", 3000, "Smooth and milky");
  const croissant = await item(food.id, "Croissant", 2000, "Baked this morning");
  const sandwich = await item(food.id, "Chicken sandwich", 4500, "Grilled chicken, avocado, house sauce");
  const passion = await item(juice.id, "Passion juice", 2000, "Fresh, no added sugar");
  const products = [espresso, cappuccino, latte, croissant, sandwich, passion];
  const tables = await call("POST", "/tables", tk, { count: 6 });

  // ---- ingredients and recipes (stock is set below so its history adds up) ----
  const ing = (name, unit, lowStockAt, unitCostRwf) => call("POST", "/inventory/ingredients", tk, { name, unit, lowStockAt, unitCostRwf, openingQuantity: 0 });
  const beans = await ing("Coffee beans", "G", 1000, 25), milk = await ing("Milk", "ML", 2000, 1.2), bread = await ing("Bread", "PCS", 10, 300);
  const recipe = (p, items) => call("PUT", `/inventory/recipes/${p.id}`, tk, { items });
  await recipe(espresso, [{ ingredientId: beans.id, quantity: 9 }]);
  await recipe(cappuccino, [{ ingredientId: beans.id, quantity: 18 }, { ingredientId: milk.id, quantity: 150 }]);
  await recipe(latte, [{ ingredientId: beans.id, quantity: 18 }, { ingredientId: milk.id, quantity: 220 }]);
  await recipe(sandwich, [{ ingredientId: bread.id, quantity: 2 }]);
  const recipes = { [espresso.id]: [[beans.id, 9]], [cappuccino.id]: [[beans.id, 18], [milk.id, 150]], [latte.id]: [[beans.id, 18], [milk.id, 220]], [sandwich.id]: [[bread.id, 2]] };
  await call("POST", "/inventory/suppliers", tk, { name: "Kigali Roasters", phone: "0788111222", notes: "Beans, weekly delivery" });

  // ---- loyalty and a promotion ----
  await call("PUT", "/marketing/loyalty", tk, { enabled: true, rwfPerPoint: 100, rewardPoints: 50, rewardName: "Free cappuccino" });
  await call("POST", "/marketing/promotions", tk, { name: "Afternoon coffee", percent: 10, categoryId: coffee.id, days: [1, 2, 3, 4, 5], startTime: "15:00", endTime: "18:00" });

  // ---- staff (the same password, so each role can be tried) ----
  const roles = await call("GET", "/roles", tk);
  const staff = [["Waiter", "waiter"], ["Cashier", "cashier"], ["Kitchen", "kitchen"], ["Manager", "manager"]];
  for (const [role, who] of staff) {
    const inv = await call("POST", "/staff/invitations", tk, { email: `${who}@restaurantos.local`, roleId: roles.find((r) => r.name === role).id });
    await call("POST", `/auth/invitations/${inv.inviteUrl.split("/invite/")[1]}/accept`, null, { fullName: `Demo ${role}`, password: PASSWORD });
  }

  // ---- four weeks of paid orders, customers, loyalty points and stock history ----
  const branch = await prisma.branch.findFirst({ where: { tenantId } });
  const names = ["Aline", "Jean Claude", "Grace", "Eric", "Diane", "Patrick", "Solange", "Olivier"];
  const customers = [];
  for (let i = 0; i < names.length; i++) { const phone = `07880000${10 + i}`; customers.push(await prisma.customer.create({ data: { tenantId, name: names[i], phone, phoneKey: phone.slice(-9) } })); } // key = last 9 digits, as the app matches phones
  const points = new Map(customers.map((c) => [c.id, 0]));
  const moves = []; const earn = [];
  let number = 1000;
  for (let daysAgo = 28; daysAgo >= 1; daysAgo--) {
    const dow = new Date(at(daysAgo, 12, 0)).getUTCDay(); const count = Math.round((dow === 0 ? 4 : dow === 6 ? 9 : 5 + (daysAgo % 4)) * (0.8 + rand() * 0.5));
    for (let i = 0; i < count; i++) {
      const hour = pick([7, 8, 9, 10, 12, 13, 15, 16, 17, 18], [1, 3, 3, 2, 3, 3, 4, 3, 2, 1]); const when = at(daysAgo, hour, Math.floor(rand() * 55));
      const lines = []; for (let k = 0, n = 1 + Math.floor(rand() * 3); k < n; k++) lines.push({ p: pick(products, [2, 5, 4, 3, 2, 2]), q: 1 + (rand() > 0.8 ? 1 : 0) });
      const subtotal = lines.reduce((s, l) => s + l.p.priceRwf * l.q, 0); const customer = rand() > 0.55 ? pick(customers) : null; number += 1;
      const order = await prisma.order.create({ data: { tenantId, branchId: branch.id, number, publicToken: crypto.randomBytes(12).toString("hex"), customerName: customer?.name || "Guest", customerPhone: customer?.phone || null, customerId: customer?.id || null,
        tableLabel: pick(tables).label, status: "COMPLETED", paymentStatus: "CONFIRMED", paymentMethod: pick(["MOBILE_MONEY", "CASH", "CARD"], [6, 3, 1]), paidAt: new Date(when.getTime() + 300000), createdAt: when, subtotalRwf: subtotal, totalRwf: subtotal,
        stockDeducted: true, loyaltyAwarded: customer ? Math.floor(subtotal / 100) : 0, proofRequired: false, items: { create: lines.map((l) => ({ productId: l.p.id, name: l.p.name, unitPriceRwf: l.p.priceRwf, quantity: l.q })) } } });
      for (const l of lines) for (const [ingredientId, q] of recipes[l.p.id] || []) moves.push({ ingredientId, delta: -q * l.q, at: when, orderId: order.id, reason: `Order #${number}` });
      if (customer) { points.set(customer.id, points.get(customer.id) + Math.floor(subtotal / 100)); earn.push({ customerId: customer.id, orderId: order.id, pts: Math.floor(subtotal / 100), at: when, number }); }
    }
  }
  // stock: an opening count 29 days ago sized so today's levels are what we want, then every sale, waste and a delivery, in order
  const target = { [beans.id]: 3200, [milk.id]: 1500, [bread.id]: 22 };
  const used = {}; for (const m of moves) used[m.ingredientId] = (used[m.ingredientId] || 0) - m.delta;
  const events = [...moves.map((m) => ({ ...m, type: "SALE" })), { ingredientId: milk.id, delta: -700, at: at(6, 11, 0), type: "WASTE", reason: "Expired" }, { ingredientId: beans.id, delta: -120, at: at(3, 12, 0), type: "WASTE", reason: "Spilled" }];
  const delivered = { [beans.id]: 4000, [milk.id]: 6000, [bread.id]: 30 };
  for (const id of Object.keys(target)) events.push({ ingredientId: id, delta: delivered[id], at: at(14, 9, 0), type: "PURCHASE", reason: "From Kigali Roasters" });
  for (const id of Object.keys(target)) { const net = events.filter((e) => e.ingredientId === id).reduce((s, e) => s + e.delta, 0); events.push({ ingredientId: id, delta: target[id] - net, at: at(29, 8, 0), type: "ADJUSTMENT", reason: "Opening stock" }); }
  const balance = {}; events.sort((a, b) => a.at - b.at);
  for (const e of events) { balance[e.ingredientId] = (balance[e.ingredientId] || 0) + e.delta; await prisma.stockMovement.create({ data: { tenantId, ingredientId: e.ingredientId, type: e.type, quantity: e.delta, balanceAfter: balance[e.ingredientId], reason: e.reason, orderId: e.orderId || null, actorName: e.type === "SALE" ? null : "Demo Owner", createdAt: e.at } }); }
  for (const id of Object.keys(target)) await prisma.ingredient.update({ where: { id }, data: { quantity: balance[id] } });
  // loyalty: points earned per order, with one reward redeemed along the way
  let run = new Map(customers.map((c) => [c.id, 0]));
  for (const e of earn.sort((a, b) => a.at - b.at)) { run.set(e.customerId, run.get(e.customerId) + e.pts); await prisma.loyaltyTransaction.create({ data: { tenantId, customerId: e.customerId, orderId: e.orderId, type: "EARN", points: e.pts, balanceAfter: run.get(e.customerId), note: `Order #${e.number}`, createdAt: e.at } }); }
  const top = [...run.entries()].sort((a, b) => b[1] - a[1])[0];
  await prisma.loyaltyTransaction.create({ data: { tenantId, customerId: top[0], type: "REDEEM", points: -50, balanceAfter: top[1] - 50, note: "Free cappuccino", actorName: "Demo Owner", createdAt: at(2, 14, 0) } }); run.set(top[0], top[1] - 50);
  for (const c of customers) await prisma.customer.update({ where: { id: c.id }, data: { loyaltyPoints: run.get(c.id) } });
  const someOrders = await prisma.order.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 3 });
  const reviews = [[5, "Best cappuccino in Kimihurura."], [4, "Lovely place, slightly slow at lunch."], [5, "Friendly staff, great croissants."]];
  for (let i = 0; i < someOrders.length; i++) await prisma.review.create({ data: { tenantId, orderId: someOrders[i].id, rating: reviews[i][0], comment: reviews[i][1], authorName: someOrders[i].customerName.split(" ")[0] } });

  // ---- live orders for the kitchen screen, and bookings ----
  const guest = async (items, name) => { const fd = new FormData(); fd.append("data", JSON.stringify({ customerName: name, items })); return call("POST", `/public/q/${tables[0].qrToken}/orders`, null, null, fd); };
  const live = [await guest([{ productId: cappuccino.id, quantity: 2 }, { productId: croissant.id, quantity: 1 }], "Table guest"), await guest([{ productId: sandwich.id, quantity: 1 }], "Walk-in"), await guest([{ productId: latte.id, quantity: 1 }], "Regular")];
  const open = (await call("GET", "/orders?view=active", tk)).items;
  const byNumber = (n) => open.find((o) => o.number === n);
  await call("PATCH", `/orders/${byNumber(live[1].number).id}/status`, tk, { status: "PREPARING" });
  await call("PATCH", `/orders/${byNumber(live[2].number).id}/status`, tk, { status: "PREPARING" }); await call("PATCH", `/orders/${byNumber(live[2].number).id}/status`, tk, { status: "READY" });
  const book = (customerName, customerPhone, partySize, time, note) => call("POST", `/public/restaurants/${slug}/reservations`, null, { customerName, customerPhone, partySize, date: ymd(1), time, note });
  await book("Claudine", "0788555010", 4, "19:00", "Birthday dinner"); const second = await book("Emmanuel", "0788555011", 2, "12:30");
  const tomorrow = (await call("GET", `/reservations?date=${ymd(1)}`, tk)).items.find((r) => r.customerName === "Emmanuel");
  await call("PATCH", `/reservations/${tomorrow.id}/status`, tk, { status: "CONFIRMED", tableLabel: "T03" });

  console.log(`
Demo business ready: "Demo Café"  (/r/${slug})
All accounts use the password: ${PASSWORD}
  Owner    ${OWNER}
  Manager  manager@restaurantos.local
  Cashier  cashier@restaurantos.local
  Waiter   waiter@restaurantos.local
  Kitchen  kitchen@restaurantos.local
Sign in at /login. Guest ordering: ${env.clientUrl}/q/${tables[0].qrToken}
Included: menu with recipes, stock history, 28 days of orders, customers and loyalty points, an afternoon promotion, reviews,
live orders in the kitchen, and bookings for tomorrow.`);
} catch (e) { console.error("\nDemo seed failed:", e.message); process.exitCode = 1; }
finally { server.close(); await prisma.$disconnect(); }
