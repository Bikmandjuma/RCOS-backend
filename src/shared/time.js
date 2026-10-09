// Business days are in the business's own timezone (e.g. Africa/Kigali), not the server's.
function tzOffsetMs(tz, instant) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - instant.getTime();
}
export const todayYmd = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
export function dayRange(tz, ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const start = new Date(guess - tzOffsetMs(tz, new Date(guess)));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
