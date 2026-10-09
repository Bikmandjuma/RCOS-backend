import { z } from "zod";
import { badRequest } from "../../shared/errors.js";
import { localParts } from "../../shared/promo.js";

export const slotBody = z.object({
  customerName: z.string({ required_error: "Enter your name" }).trim().min(2, "Enter your name").max(60),
  customerPhone: z.string({ required_error: "Enter a phone number" }).trim().min(7, "Enter a phone number we can call").max(20),
  partySize: z.number({ required_error: "How many people?", invalid_type_error: "How many people?" }).int().min(1, "At least 1 guest"),
  date: z.string({ required_error: "Choose a date" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  time: z.string({ required_error: "Choose a time" }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time"),
  note: z.string().trim().max(200).optional().or(z.literal("")),
});

const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** A booking must be in the future, within 60 days, inside opening hours, and fit the party-size limit. */
export function checkSlot(tenant, branch, b) {
  const now = localParts(tenant.timezone);
  if (b.partySize > tenant.maxPartySize) throw badRequest(`We take bookings for up to ${tenant.maxPartySize} guests. Please call us for larger groups.`);
  if (b.date < now.ymd) throw badRequest("That date has already passed.");
  if (b.date > addDays(now.ymd, 60)) throw badRequest("Bookings open up to 60 days ahead.");
  if (b.date === now.ymd && b.time <= now.hm) throw badRequest("That time has already passed today.");
  if (branch && branch.opensAt <= branch.closesAt && (b.time < branch.opensAt || b.time >= branch.closesAt)) {
    throw badRequest(`We're open ${branch.opensAt}–${branch.closesAt}. Choose a time in that window.`);
  }
}
