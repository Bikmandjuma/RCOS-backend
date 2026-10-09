import { prisma } from "../../shared/db.js";
import { dayRange, todayYmd } from "../../shared/time.js";
import { statusOf } from "../inventory/stock.service.js";

// Everything here is read-only maths over the business's own records. Money is counted on the day
// payment was confirmed (cash basis, like the daily closing report); refunds on the day they were recorded.
const DAY = 86_400_000;
export const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function localizer(tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  return (d) => { const p = f.formatToParts(d); const g = (t) => p.find((x) => x.type === t).value; return { ymd: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) }; };
}
const sum = (a) => a.reduce((n, x) => n + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

const paidOrders = (tenantId, from, to) => prisma.order.findMany({ where: { tenantId, paymentStatus: "CONFIRMED", status: { not: "CANCELLED" }, paidAt: { gte: from, lt: to } }, include: { items: true } });

function totalsOf(orders, refunds) {
  const gross = sum(orders.map((o) => o.totalRwf)); const ref = sum(refunds.map((r) => r.amountRwf));
  return { grossRwf: gross, refundsRwf: ref, netRwf: gross - ref, orders: orders.length, averageOrderRwf: orders.length ? Math.round(gross / orders.length) : 0 };
}

async function recipeCosts(tenantId) {
  const rows = await prisma.recipeItem.findMany({ where: { tenantId }, include: { ingredient: true } });
  const cost = new Map();
  for (const r of rows) cost.set(r.productId, (cost.get(r.productId) || 0) + r.quantity * r.ingredient.unitCostRwf);
  return cost;
}

export async function overview(tenant, days) {
  const tz = tenant.timezone, tenantId = tenant.id, local = localizer(tz), today = todayYmd(tz);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, -(days - 1 - i)));
  const start = dayRange(tz, dates[0]).start, end = dayRange(tz, today).end, prevStart = dayRange(tz, addDays(dates[0], -days)).start;

  const [all, allRefunds, products, costs] = await Promise.all([
    paidOrders(tenantId, prevStart, end),
    prisma.refund.findMany({ where: { tenantId, createdAt: { gte: prevStart, lt: end } } }),
    prisma.product.findMany({ where: { tenantId } }),
    recipeCosts(tenantId),
  ]);
  const cur = all.filter((o) => o.paidAt >= start), prev = all.filter((o) => o.paidAt < start);
  const curRef = allRefunds.filter((r) => r.createdAt >= start), prevRef = allRefunds.filter((r) => r.createdAt < start);

  const series = new Map(dates.map((d) => [d, { date: d, grossRwf: 0, refundsRwf: 0, netRwf: 0, orders: 0 }]));
  for (const o of cur) { const s = series.get(local(o.paidAt).ymd); if (s) { s.grossRwf += o.totalRwf; s.orders += 1; } }
  for (const r of curRef) { const s = series.get(local(r.createdAt).ymd); if (s) s.refundsRwf += r.amountRwf; }
  for (const s of series.values()) s.netRwf = s.grossRwf - s.refundsRwf;

  // when orders are placed (paid orders only)
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, salesRwf: 0 }));
  const weekdays = DOW.map((name, dow) => ({ dow, name, orders: 0, salesRwf: 0 }));
  for (const o of cur) { const l = local(o.createdAt); hours[l.hour].orders += 1; hours[l.hour].salesRwf += o.totalRwf; const w = weekdays[dowOf(l.ymd)]; w.orders += 1; w.salesRwf += o.totalRwf; }

  const byProduct = (orders) => { const m = new Map(); for (const o of orders) for (const i of o.items) { const k = i.productId || `name:${i.name}`; const c = m.get(k) || { productId: i.productId, name: i.name, quantity: 0, revenueRwf: 0 }; c.quantity += i.quantity; c.revenueRwf += i.quantity * i.unitPriceRwf; m.set(k, c); } return m; };
  const curP = byProduct(cur), prevP = byProduct(prev);
  const ranked = [...curP.values()].sort((a, b) => b.revenueRwf - a.revenueRwf);
  const sold = new Map([...curP.values()].filter((p) => p.productId).map((p) => [p.productId, p]));
  const worst = products.map((p) => ({ productId: p.id, name: p.name, isAvailable: p.isAvailable, quantity: sold.get(p.id)?.quantity || 0, revenueRwf: sold.get(p.id)?.revenueRwf || 0 })).sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name)).slice(0, 5);

  const margins = ranked.filter((p) => p.productId && costs.has(p.productId)).map((p) => {
    const cost = Math.round(p.quantity * costs.get(p.productId)); const margin = p.revenueRwf - cost;
    return { ...p, costRwf: cost, marginRwf: margin, marginPct: p.revenueRwf ? Math.round((margin / p.revenueRwf) * 100) : 0 };
  });

  const deltas = [...new Set([...curP.keys(), ...prevP.keys()])].map((k) => { const c = curP.get(k), p = prevP.get(k); return { name: (c || p).name, deltaRwf: (c?.revenueRwf || 0) - (p?.revenueRwf || 0), quantity: c?.quantity || 0, prevQuantity: p?.quantity || 0 }; });

  const methods = new Map(); for (const o of cur) { const k = o.paymentMethod || "OTHER"; const c = methods.get(k) || { method: k, orders: 0, amountRwf: 0 }; c.orders += 1; c.amountRwf += o.totalRwf; methods.set(k, c); }

  const [wasteRows, newCustomers, points, ingredients] = await Promise.all([
    prisma.stockMovement.groupBy({ by: ["ingredientId"], where: { tenantId, type: "WASTE", createdAt: { gte: start, lt: end } }, _sum: { quantity: true } }),
    prisma.customer.count({ where: { tenantId, createdAt: { gte: start, lt: end } } }),
    prisma.loyaltyTransaction.groupBy({ by: ["type"], where: { tenantId, createdAt: { gte: start, lt: end } }, _sum: { points: true } }),
    prisma.ingredient.findMany({ where: { tenantId } }),
  ]);
  const ing = new Map(ingredients.map((i) => [i.id, i]));
  const waste = wasteRows.map((w) => { const i = ing.get(w.ingredientId); const q = -(w._sum.quantity || 0); return { ingredient: i?.name || "Removed ingredient", unit: i?.unit, quantity: q, costRwf: Math.round(q * (i?.unitCostRwf || 0)) }; }).sort((a, b) => b.costRwf - a.costRwf);
  const pts = Object.fromEntries(points.map((p) => [p.type, p._sum.points || 0]));

  const totals = totalsOf(cur, curRef), previous = totalsOf(prev, prevRef);
  const peak = [...hours].sort((a, b) => b.orders - a.orders)[0];
  return {
    days, from: dates[0], to: today, timezone: tz, currency: tenant.currency,
    totals, previous, change: { grossPct: pct(totals.grossRwf, previous.grossRwf), netPct: pct(totals.netRwf, previous.netRwf), ordersPct: pct(totals.orders, previous.orders), averageOrderPct: pct(totals.averageOrderRwf, previous.averageOrderRwf) },
    daily: [...series.values()], hours, weekdays, peakHour: peak && peak.orders > 0 ? peak.hour : null,
    topProducts: ranked.slice(0, 8), worstSellers: worst, margins, productChanges: deltas.sort((a, b) => a.deltaRwf - b.deltaRwf),
    paymentMix: [...methods.values()].sort((a, b) => b.amountRwf - a.amountRwf),
    waste: { totalCostRwf: sum(waste.map((w) => w.costRwf)), items: waste.slice(0, 5) },
    promotions: { discountRwf: sum(cur.map((o) => o.discountRwf)), discountedOrders: cur.filter((o) => o.discountRwf > 0).length },
    customers: { newCustomers, pointsEarned: pts.EARN || 0, pointsRedeemed: -(pts.REDEEM || 0) },
  };
}

// ---------- forecast ----------
export async function forecast(tenant) {
  const tz = tenant.timezone, tenantId = tenant.id, local = localizer(tz), today = todayYmd(tz);
  const winStart = addDays(today, -56);
  const orders = await paidOrders(tenantId, dayRange(tz, winStart).start, dayRange(tz, today).start); // complete days only
  const dayRows = new Map(); const prodDay = new Map();
  for (const o of orders) {
    const ymd = local(o.paidAt).ymd; const d = dayRows.get(ymd) || { orders: 0, sales: 0 }; d.orders += 1; d.sales += o.totalRwf; dayRows.set(ymd, d);
    for (const i of o.items) { const k = i.productId || `name:${i.name}`; const m = prodDay.get(k) || { name: i.name, productId: i.productId, byDay: new Map() }; m.byDay.set(ymd, (m.byDay.get(ymd) || 0) + i.quantity); prodDay.set(k, m); }
  }
  const firstData = [...dayRows.keys()].sort()[0] || null;
  const historyDays = firstData ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${firstData}T00:00:00Z`)) / DAY) : 0;

  // days in the window, from the first day with data, that fall on a given weekday (zero-sales days count)
  const occurrences = (dow) => { const out = []; if (!firstData) return out; for (let d = firstData; d < today; d = addDays(d, 1)) if (dowOf(d) === dow) out.push(d); return out; };

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i + 1), dow = dowOf(date), occ = occurrences(dow);
    const enough = occ.length >= 2;
    const orderVals = occ.map((d) => dayRows.get(d)?.orders || 0), salesVals = occ.map((d) => dayRows.get(d)?.sales || 0);
    return { date, weekday: DOW[dow], enough, basedOnWeeks: occ.length,
      expectedOrders: enough ? Math.round(mean(orderVals)) : null, expectedSalesRwf: enough ? Math.round(mean(salesVals)) : null,
      lowSalesRwf: enough ? Math.max(0, Math.round(mean(salesVals) - std(salesVals))) : null, highSalesRwf: enough ? Math.round(mean(salesVals) + std(salesVals)) : null };
  });

  const tomorrow = days[0]; const occT = occurrences(dowOf(tomorrow.date));
  const products = tomorrow.enough ? [...prodDay.values()].map((p) => ({ productId: p.productId, name: p.name, expectedQuantity: Math.round(mean(occT.map((d) => p.byDay.get(d) || 0)) * 10) / 10 })).filter((p) => p.expectedQuantity > 0).sort((a, b) => b.expectedQuantity - a.expectedQuantity).slice(0, 10) : [];

  let ingredients = [];
  if (tomorrow.enough && products.length) {
    const [recipe, stock] = await Promise.all([prisma.recipeItem.findMany({ where: { tenantId, productId: { in: products.map((p) => p.productId).filter(Boolean) } } }), prisma.ingredient.findMany({ where: { tenantId } })]);
    const need = new Map();
    for (const p of products) for (const r of recipe.filter((x) => x.productId === p.productId)) need.set(r.ingredientId, (need.get(r.ingredientId) || 0) + r.quantity * p.expectedQuantity);
    ingredients = [...need.entries()].map(([id, q]) => { const i = stock.find((s) => s.id === id); const needed = Math.round(q); return { ingredientId: id, name: i.name, unit: i.unit, expectedNeed: needed, inStock: i.quantity, shortBy: Math.max(0, needed - i.quantity), mayRunShort: needed > i.quantity }; }).sort((a, b) => b.shortBy - a.shortBy || a.name.localeCompare(b.name));
  }
  return { historyDays, enough: days.some((d) => d.enough), days, tomorrow: { date: tomorrow.date, weekday: tomorrow.weekday, products, ingredients }, note: "An estimate from the same weekday in past weeks. It is not a guarantee." };
}

// ---------- alerts (anomalies and things that need attention) ----------
const SEV = { attention: 0, warning: 1, info: 2 };
export async function alerts(tenant, now = new Date()) {
  const tz = tenant.timezone, tenantId = tenant.id, local = localizer(tz), today = todayYmd(tz);
  const yesterday = addDays(today, -1), out = [];
  const add = (a) => out.push(a);

  // 1. yesterday's sales vs the same weekday in recent weeks
  const base = [1, 2, 3, 4].map((w) => addDays(yesterday, -7 * w));
  const from = dayRange(tz, addDays(yesterday, -28)).start, to = dayRange(tz, yesterday).end;
  const [orders, refunds] = await Promise.all([paidOrders(tenantId, from, to), prisma.refund.findMany({ where: { tenantId, createdAt: { gte: from, lt: to } } })]);
  const net = new Map(); for (const o of orders) { const k = local(o.paidAt).ymd; net.set(k, (net.get(k) || 0) + o.totalRwf); }
  for (const r of refunds) { const k = local(r.createdAt).ymd; net.set(k, (net.get(k) || 0) - r.amountRwf); }
  const baseVals = base.map((d) => net.get(d) || 0).filter((v) => v > 0);
  const y = net.get(yesterday) || 0, med = median(baseVals);
  if (baseVals.length >= 3 && med >= 1000) {
    if (y < med * 0.5) add({ key: "sales-low", severity: "attention", title: "Yesterday's sales were well below normal", detail: `RWF ${Math.round(y).toLocaleString("en-US")} against a typical ${DOW[dowOf(yesterday)]} of about RWF ${Math.round(med).toLocaleString("en-US")}. Check the afternoon orders, availability of popular items, and any promotions that ended.`, link: "/app/analytics" });
    else if (y > med * 1.5) add({ key: "sales-high", severity: "info", title: "Yesterday's sales were well above normal", detail: `RWF ${Math.round(y).toLocaleString("en-US")} against a typical ${DOW[dowOf(yesterday)]} of about RWF ${Math.round(med).toLocaleString("en-US")}. Make sure stock covers a repeat.`, link: "/app/analytics" });
  }

  // 2. unusual ingredient use yesterday (wording is deliberately neutral: it flags a variance, not a cause)
  const mFrom = dayRange(tz, addDays(yesterday, -14)).start;
  const [moves, ings, waste] = await Promise.all([
    prisma.stockMovement.findMany({ where: { tenantId, type: "SALE", createdAt: { gte: mFrom, lt: to } }, select: { ingredientId: true, quantity: true, createdAt: true } }),
    prisma.ingredient.findMany({ where: { tenantId } }),
    prisma.stockMovement.findMany({ where: { tenantId, type: "WASTE", createdAt: { gte: dayRange(tz, addDays(today, -14)).start } }, select: { ingredientId: true, quantity: true, createdAt: true } }),
  ]);
  const use = new Map();
  for (const m of moves) { const k = m.ingredientId; const byDay = use.get(k) || new Map(); const d = local(m.createdAt).ymd; byDay.set(d, (byDay.get(d) || 0) - m.quantity); use.set(k, byDay); }
  for (const [id, byDay] of use) {
    const yv = byDay.get(yesterday) || 0; const prior = [...byDay.entries()].filter(([d]) => d !== yesterday).map(([, v]) => v);
    if (prior.length >= 3 && yv >= 2 * mean(prior) && yv - mean(prior) >= 100) {
      const i = ings.find((x) => x.id === id);
      add({ key: `use-${id}`, severity: "warning", title: `Unusual use of ${i?.name || "an ingredient"} yesterday`, detail: `${yv.toLocaleString("en-US")} used against a usual ${Math.round(mean(prior)).toLocaleString("en-US")} a day. Unusual stock variance detected: review yesterday's orders, waste records and stock counts.`, link: "/app/inventory" });
    }
  }
  const cost = new Map(ings.map((i) => [i.id, i.unitCostRwf]));
  const w7 = dayRange(tz, addDays(today, -6)).start;
  const wasteCost = (rows) => sum(rows.map((m) => -m.quantity * (cost.get(m.ingredientId) || 0)));
  const wThis = wasteCost(waste.filter((m) => m.createdAt >= w7)), wPrev = wasteCost(waste.filter((m) => m.createdAt < w7));
  if (wThis >= 5000 && wThis > 2 * wPrev) add({ key: "waste", severity: "warning", title: "Waste has risen this week", detail: `About RWF ${Math.round(wThis).toLocaleString("en-US")} of waste in the last 7 days, compared with RWF ${Math.round(wPrev).toLocaleString("en-US")} the week before.`, link: "/app/inventory" });

  // 3. refunds
  const r7 = refunds.filter((r) => r.createdAt >= w7); const rAmt = sum(r7.map((r) => r.amountRwf));
  const gross7 = sum(orders.filter((o) => o.paidAt >= w7).map((o) => o.totalRwf));
  if (rAmt >= 5000 && gross7 > 0 && rAmt / gross7 > 0.1) add({ key: "refunds", severity: "warning", title: "Refunds are high this week", detail: `RWF ${rAmt.toLocaleString("en-US")} refunded: ${Math.round((rAmt / gross7) * 100)}% of sales. Look at the reasons on the Activity page.`, link: "/app/activity" });

  // 4. things waiting right now
  const [proofs, waiting, lows] = await Promise.all([
    prisma.order.findMany({ where: { tenantId, paymentStatus: "PROOF_SUBMITTED", status: { not: "CANCELLED" }, createdAt: { lt: new Date(now.getTime() - 30 * 60_000) } }, select: { number: true } }),
    prisma.order.findMany({ where: { tenantId, status: "PLACED", paymentStatus: { in: ["CONFIRMED", "NOT_REQUIRED"] }, createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } }, select: { number: true, createdAt: true } }),
    Promise.resolve(ings.filter((i) => statusOf(i) !== "OK")),
  ]);
  if (proofs.length) add({ key: "proofs", severity: "attention", title: `${proofs.length} payment proof${proofs.length === 1 ? "" : "s"} waiting 30+ minutes`, detail: `Order${proofs.length === 1 ? "" : "s"} ${proofs.map((p) => `#${p.number}`).join(", ")}: the kitchen can't start until payment is confirmed.`, link: "/app/orders?view=review" });
  if (waiting.length) add({ key: "kitchen", severity: "attention", title: `${waiting.length} paid order${waiting.length === 1 ? "" : "s"} not started after 15+ minutes`, detail: waiting.map((o) => `#${o.number} (${Math.floor((now - o.createdAt) / 60000)} min)`).join(", "), link: "/app/kitchen" });
  if (lows.length) add({ key: "stock", severity: lows.some((i) => statusOf(i) === "OUT") ? "attention" : "warning", title: `${lows.length} ingredient${lows.length === 1 ? " is" : "s are"} low or out`, detail: lows.slice(0, 5).map((i) => i.name).join(", "), link: "/app/inventory" });

  return { generatedAt: now, alerts: out.sort((a, b) => SEV[a.severity] - SEV[b.severity]) };
}
