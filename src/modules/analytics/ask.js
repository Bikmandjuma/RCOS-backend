import { overview, forecast } from "./analytics.service.js";
import { prisma } from "../../shared/db.js";
import { statusOf } from "../inventory/stock.service.js";

// "Quick answers": a fixed set of questions answered by running the analytics above and phrasing the
// verified numbers. It is rule-based — it does not understand free text beyond keywords and never invents figures.
const rwf = (n) => `RWF ${Math.round(n).toLocaleString("en-US")}`;
const hhmm = (h) => `${String(h).padStart(2, "0")}:00`;
const unitText = (n, u) => (u === "PCS" ? `${n} pcs` : n >= 1000 ? `${Number((n / 1000).toFixed(2))} ${u === "G" ? "kg" : "L"}` : `${n} ${u === "G" ? "g" : "ml"}`);

export const QUESTIONS = [
  { id: "sales", label: "How were sales this week?", needs: "reports.view", keys: /(sales|revenue|takings|how much).*(week|7 days|made|earn)|how were sales|sales this week/ },
  { id: "why", label: "Why were sales lower?", needs: "reports.view", keys: /why.*(lower|down|drop|less|worse)|sales (dropped|fell)|compare|vs last|than last/ },
  { id: "best", label: "What are my best sellers?", needs: "reports.view", keys: /best|top|most popular|selling well|bestsell/ },
  { id: "worst", label: "Which products sell poorly?", needs: "reports.view", keys: /poor|worst|slow|not selling|least|selling badly/ },
  { id: "peak", label: "When are we busiest?", needs: "reports.view", keys: /busiest|peak|rush|busy|which hour|what time|hours? .*(order|sales)/ },
  { id: "margin", label: "Which products have high sales but low margin?", needs: "reports.view", keys: /margin|profit|low margin|expensive to make|cost/ },
  { id: "tomorrow", label: "What do we expect tomorrow?", needs: "reports.view", keys: /tomorrow|forecast|expect|predict|next week/ },
  { id: "promote", label: "What should I promote?", needs: "reports.view", keys: /promot|offer|discount|deal|campaign/ },
  { id: "waste", label: "What are we wasting?", needs: "inventory.view", keys: /wast(e|ed|ing)|spoil|throw(n|ing)? (away|out)|thrown/ },
  { id: "stock", label: "What's running low?", needs: "inventory.view", keys: /stock|running low|reorder|run out|ingredient|low on/ },
];

export function matchQuestion(text) {
  const t = String(text || "").toLowerCase().trim();
  return QUESTIONS.find((q) => q.id === t) || QUESTIONS.find((q) => q.keys.test(t)) || null;
}

export async function answer(tenant, q) {
  const facts = []; let text;
  if (q.id === "sales" || q.id === "why") {
    const o = await overview(tenant, 7);
    const c = o.change.grossPct;
    if (q.id === "sales") {
      text = o.totals.orders === 0 ? "No paid orders in the last 7 days." : `Over the last 7 days you took ${rwf(o.totals.grossRwf)} from ${o.totals.orders} paid order${o.totals.orders === 1 ? "" : "s"} (average ${rwf(o.totals.averageOrderRwf)}), ${rwf(o.totals.netRwf)} after refunds.${c === null ? " There's no earlier week to compare with yet." : ` That is ${Math.abs(c)}% ${c >= 0 ? "more" : "less"} than the 7 days before.`}`;
    } else if (c === null) text = "There isn't a previous week with sales to compare against yet.";
    else if (c >= 0) text = `Sales weren't lower: the last 7 days are ${c}% above the 7 days before (${rwf(o.totals.grossRwf)} vs ${rwf(o.previous.grossRwf)}).`;
    else {
      const down = o.productChanges.filter((p) => p.deltaRwf < 0).slice(0, 3);
      text = `The last 7 days are ${Math.abs(c)}% lower than the 7 days before (${rwf(o.totals.grossRwf)} vs ${rwf(o.previous.grossRwf)}), with ${o.totals.orders} orders against ${o.previous.orders}.${down.length ? ` The biggest falls were ${down.map((p) => `${p.name} (${rwf(p.deltaRwf)})`).join(", ")}.` : ""} Check whether those items were unavailable, or a promotion ended.`;
    }
    facts.push(["Last 7 days", rwf(o.totals.grossRwf)], ["Previous 7 days", rwf(o.previous.grossRwf)], ["Orders", `${o.totals.orders} (was ${o.previous.orders})`]);
  } else if (q.id === "best" || q.id === "worst") {
    const o = await overview(tenant, 30);
    if (q.id === "best") { text = o.topProducts.length ? `In the last 30 days your top sellers by revenue were ${o.topProducts.slice(0, 3).map((p) => `${p.name} (${p.quantity} sold, ${rwf(p.revenueRwf)})`).join(", ")}.` : "No paid orders in the last 30 days."; o.topProducts.slice(0, 5).forEach((p) => facts.push([p.name, `${p.quantity} sold · ${rwf(p.revenueRwf)}`])); }
    else { const w = o.worstSellers.filter((p) => p.isAvailable); text = w.length ? `The slowest items on your menu in the last 30 days: ${w.slice(0, 3).map((p) => `${p.name} (${p.quantity} sold)`).join(", ")}. Consider a promotion, a better position on the menu, or removing items nobody orders.` : "Your menu has no items yet."; w.forEach((p) => facts.push([p.name, `${p.quantity} sold`])); }
  } else if (q.id === "peak") {
    const o = await overview(tenant, 30);
    const top = [...o.hours].sort((a, b) => b.orders - a.orders).slice(0, 3).filter((h) => h.orders > 0);
    const day = [...o.weekdays].sort((a, b) => b.orders - a.orders)[0];
    text = top.length ? `Most paid orders are placed around ${top.map((h) => `${hhmm(h.hour)}–${hhmm((h.hour + 1) % 24)} (${h.orders})`).join(", ")}. Your busiest day is ${day.name}.` : "There aren't enough paid orders in the last 30 days to see a pattern.";
    top.forEach((h) => facts.push([`${hhmm(h.hour)}`, `${h.orders} orders · ${rwf(h.salesRwf)}`]));
  } else if (q.id === "margin") {
    const o = await overview(tenant, 30);
    if (!o.margins.length) text = "I can only work out margins for items that have a recipe. Add recipes in Menu and I'll show which sellers earn the least.";
    else {
      const sorted = [...o.margins].sort((a, b) => b.quantity - a.quantity); const popular = sorted.slice(0, Math.max(3, Math.ceil(sorted.length / 2)));
      const low = popular.filter((p) => p.marginPct < 50).sort((a, b) => a.marginPct - b.marginPct);
      text = low.length ? `Popular items with a thin margin (under 50%): ${low.slice(0, 3).map((p) => `${p.name} (${p.marginPct}% margin on ${p.quantity} sold)`).join(", ")}. A small price rise or a cheaper recipe would help most here.` : `None of your popular items with recipes has a margin under 50%. The lowest is ${sorted.sort((a, b) => a.marginPct - b.marginPct)[0].name} at ${sorted[0].marginPct}%.`;
      o.margins.slice(0, 6).forEach((p) => facts.push([p.name, `${p.marginPct}% margin · ${p.quantity} sold`]));
    }
  } else if (q.id === "tomorrow") {
    const f = await forecast(tenant); const d = f.days[0];
    if (!d.enough) text = `I don't have enough history yet (${f.historyDays} day${f.historyDays === 1 ? "" : "s"}). I need at least two ${d.weekday}s of data to estimate that day.`;
    else {
      const short = f.tomorrow.ingredients.filter((i) => i.mayRunShort);
      text = `Tomorrow is ${d.weekday}. Based on the last ${d.basedOnWeeks} ${d.weekday}s, expect about ${d.expectedOrders} orders and ${rwf(d.expectedSalesRwf)} (roughly ${rwf(d.lowSalesRwf)} to ${rwf(d.highSalesRwf)}).${short.length ? ` Stock may run short on ${short.slice(0, 3).map((i) => `${i.name} (need about ${unitText(i.expectedNeed, i.unit)}, have ${unitText(Math.max(0, i.inStock), i.unit)})`).join(", ")}.` : ""} This is an estimate, not a guarantee.`;
      f.tomorrow.products.slice(0, 5).forEach((p) => facts.push([p.name, `about ${Math.round(p.expectedQuantity)}`]));
    }
  } else if (q.id === "promote") {
    const o = await overview(tenant, 30);
    const withCost = o.margins.filter((p) => p.quantity >= 3 && p.marginPct >= 60).sort((a, b) => b.marginRwf - a.marginRwf).slice(0, 2);
    const peak = o.peakHour;
    if (withCost.length) { text = `${withCost.map((p) => `${p.name} (${p.marginPct}% margin, ${p.quantity} sold)`).join(" and ")} earn well and already sell. ${peak !== null ? `Most orders arrive around ${hhmm(peak)}, so a promotion just before or after that window could add volume.` : ""} Promote them rather than your lowest-margin items.`; withCost.forEach((p) => facts.push([p.name, `${p.marginPct}% margin`])); }
    else if (o.topProducts.length) { text = `You haven't set recipes for your best sellers, so I can't see margins. By sales alone, ${o.topProducts[0].name} is your strongest item. Add recipes so I can suggest what's both popular and profitable.`; }
    else text = "There isn't enough sales history yet to suggest a promotion.";
  } else if (q.id === "waste") {
    const o = await overview(tenant, 30);
    text = o.waste.items.length ? `In the last 30 days you recorded about ${rwf(o.waste.totalCostRwf)} of waste at current costs. The biggest: ${o.waste.items.slice(0, 3).map((w) => `${w.ingredient} (${rwf(w.costRwf)})`).join(", ")}.` : "No waste was recorded in the last 30 days.";
    o.waste.items.forEach((w) => facts.push([w.ingredient, `${rwf(w.costRwf)}`]));
  } else if (q.id === "stock") {
    const ings = await prisma.ingredient.findMany({ where: { tenantId: tenant.id } });
    const low = ings.filter((i) => statusOf(i) !== "OK");
    text = low.length ? `${low.length} ingredient${low.length === 1 ? " is" : "s are"} low or out: ${low.slice(0, 6).map((i) => `${i.name} (${statusOf(i) === "OUT" ? "out" : unitText(i.quantity, i.unit)})`).join(", ")}.` : "Nothing is below its warning level.";
    low.slice(0, 6).forEach((i) => facts.push([i.name, statusOf(i) === "OUT" ? "Out" : unitText(i.quantity, i.unit)]));
  }
  return { id: q.id, question: q.label, answer: text, facts: facts.map(([label, value]) => ({ label, value })) };
}
