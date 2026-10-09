// Promotion rules: pure functions, so they're easy to test and identical wherever they're used.
// A promotion is a percentage off, optionally limited to a category, days of the week, a time window
// and a date range — all evaluated in the business's own timezone.

export function localParts(tz, now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")];
  return { ymd: `${g("year")}-${g("month")}-${g("day")}`, dow, hm: `${g("hour")}:${g("minute")}` };
}

export function promoActive(p, parts) {
  if (!p.isActive) return false;
  if (p.startDate && parts.ymd < p.startDate) return false;
  if (p.endDate && parts.ymd > p.endDate) return false;
  if (p.days && !p.days.split(",").map(Number).includes(parts.dow)) return false;
  if (p.startTime && p.endTime) {
    // supports windows that cross midnight (e.g. 22:00–02:00)
    const inside = p.startTime <= p.endTime ? parts.hm >= p.startTime && parts.hm < p.endTime : parts.hm >= p.startTime || parts.hm < p.endTime;
    if (!inside) return false;
  }
  return true;
}

/** Best single promotion per line (no stacking). Returns totals plus the names that applied. */
export function priceLines(lines, promos, parts) {
  const live = promos.filter((p) => promoActive(p, parts));
  let subtotal = 0, discount = 0;
  const used = new Set();
  const priced = lines.map((l) => {
    const gross = l.unitPriceRwf * l.quantity;
    const best = live.filter((p) => !p.categoryId || p.categoryId === l.categoryId).sort((a, b) => b.percent - a.percent)[0];
    const off = best ? Math.floor((gross * best.percent) / 100) : 0;
    subtotal += gross; discount += off;
    if (best && off > 0) used.add(best.name);
    return { ...l, grossRwf: gross, discountRwf: off, promotion: best?.name || null };
  });
  return { lines: priced, subtotalRwf: subtotal, discountRwf: discount, totalRwf: subtotal - discount, promotionNames: [...used] };
}

export const promoView = (p, activeNow) => ({
  id: p.id, name: p.name, percent: p.percent, categoryId: p.categoryId, days: p.days ? p.days.split(",").map(Number) : null,
  startTime: p.startTime, endTime: p.endTime, startDate: p.startDate, endDate: p.endDate, isActive: p.isActive, ...(activeNow !== undefined ? { activeNow } : {}),
});

/** Data-driven customer segments (PDF §28). Rules are simple and documented in the README. */
export function segmentFor({ paidOrders, lastPaidAt }, now = new Date()) {
  if (paidOrders === 0) return "NEW";
  const idleDays = lastPaidAt ? (now.getTime() - new Date(lastPaidAt).getTime()) / 86_400_000 : 0;
  if (idleDays > 60) return "INACTIVE";
  if (paidOrders >= 10) return "VIP";
  if (paidOrders >= 3) return "REGULAR";
  return "NEW";
}
