import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { ok, created } from "../../shared/http.js";
import { AppError, asyncHandler, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { hasAccess } from "../billing/subscription.js";
import { customerForGuest } from "../customers/customers.service.js";
import { checkSlot, slotBody } from "../reservations/slots.js";
import { FLOW, newToken } from "../reservations/reservations.routes.js";
import { audit } from "../../shared/audit.js";

export const engageRouter = Router();

// Per device and restaurant (many guests share one Wi-Fi address).
const limiter = (what) => env.isTest ? (_q, _s, n) => n() : rateLimit({
  windowMs: 10 * 60_000, limit: 15, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${req.params.slug || req.params.token}|${what}`,
  message: { statusCode: 429, message: "Too many tries from this device. Please wait a few minutes." },
});

const guestView = (r, t) => ({
  restaurant: { name: t.name, brandColor: t.brandColor, phone: t.phone },
  customerName: r.customerName, partySize: r.partySize, date: r.date, time: r.time, note: r.note,
  status: r.status, statusNote: r.statusNote, tableLabel: r.tableLabel,
});

async function openTenant(slug) {
  const t = await prisma.tenant.findUnique({ where: { slug: String(slug).toLowerCase() }, include: { subscription: true } });
  if (!t || t.status !== "ACTIVE") throw notFound("We couldn't find this restaurant.");
  return t;
}

engageRouter.post("/restaurants/:slug/reservations", limiter("book"), asyncHandler(async (req, res) => {
  const t = await openTenant(req.params.slug);
  if (!t.acceptReservations || !t.subscription || !hasAccess(t.subscription)) throw new AppError(403, "This restaurant isn't taking online bookings right now. Please call them.", "RESERVATIONS_OFF");
  const b = parse(slotBody, req.body);
  checkSlot(t, await prisma.branch.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: "asc" } }), b);
  const customer = await customerForGuest(t.id, { name: b.customerName, phone: b.customerPhone });
  const r = await prisma.reservation.create({ data: { tenantId: t.id, publicToken: newToken(), customerName: b.customerName, customerPhone: b.customerPhone, customerId: customer?.id || null, partySize: b.partySize, date: b.date, time: b.time, note: b.note || null } });
  return created(res, { token: r.publicToken }, "Booking request sent.");
}));

engageRouter.get("/reservations/:token", asyncHandler(async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { publicToken: String(req.params.token) } });
  if (!r) throw notFound("We couldn't find this booking.");
  const t = await prisma.tenant.findUnique({ where: { id: r.tenantId } });
  return ok(res, guestView(r, t));
}));

engageRouter.post("/reservations/:token/cancel", limiter("cancel"), asyncHandler(async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { publicToken: String(req.params.token) } });
  if (!r) throw notFound("We couldn't find this booking.");
  if (!FLOW[r.status].includes("CANCELLED") || r.status === "ARRIVED") throw conflict("This booking can't be cancelled any more. Please call the restaurant.");
  const claim = await prisma.reservation.updateMany({ where: { id: r.id, status: r.status }, data: { status: "CANCELLED", statusNote: "Cancelled by the guest" } });
  if (claim.count === 0) throw conflict("This booking just changed. Refresh to see the latest.");
  await audit(null, { tenantId: r.tenantId, actor: { fullName: r.customerName }, action: "reservation.status", entityType: "reservation", entityId: r.id, summary: `${r.customerName} cancelled their booking (${r.date} ${r.time})` });
  return ok(res, { status: "CANCELLED" }, "Booking cancelled.");
}));

// One review per order, only for orders that were paid and served.
engageRouter.post("/orders/:token/review", limiter("review"), asyncHandler(async (req, res) => {
  const b = parse(z.object({ rating: z.number({ required_error: "Choose a rating", invalid_type_error: "Choose a rating" }).int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"), comment: z.string().trim().max(300).optional().or(z.literal("")) }), req.body);
  const o = await prisma.order.findUnique({ where: { publicToken: String(req.params.token) } });
  if (!o) throw notFound("We couldn't find this order.");
  if (o.paymentStatus !== "CONFIRMED" || !["SERVED", "COMPLETED"].includes(o.status)) throw conflict("You can leave a review once your order has been paid and served.");
  try {
    await prisma.review.create({ data: { tenantId: o.tenantId, orderId: o.id, rating: b.rating, comment: b.comment || null, authorName: o.customerName.split(" ")[0] } });
  } catch (e) { if (e.code === "P2002") throw conflict("You've already reviewed this order. Thank you!"); throw e; }
  return created(res, { rating: b.rating }, "Thank you for your review.");
}));
