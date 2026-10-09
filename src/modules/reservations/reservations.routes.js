import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { localParts } from "../../shared/promo.js";
import { customerForGuest } from "../customers/customers.service.js";
import { checkSlot, slotBody } from "./slots.js";

export const reservationsRouter = Router();
reservationsRouter.use(authenticate);

export const FLOW = {
  PENDING: ["CONFIRMED", "REJECTED", "CANCELLED"],
  CONFIRMED: ["ARRIVED", "CANCELLED", "NO_SHOW"],
  ARRIVED: ["SEATED", "CANCELLED"],
  SEATED: ["COMPLETED"],
  REJECTED: [], CANCELLED: [], NO_SHOW: [], COMPLETED: [],
};
const TOKEN_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
export const newToken = () => Array.from(crypto.randomBytes(14), (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join("");

export const resView = (r) => ({ id: r.id, customerName: r.customerName, customerPhone: r.customerPhone, partySize: r.partySize, date: r.date, time: r.time, note: r.note, status: r.status, statusNote: r.statusNote, tableLabel: r.tableLabel, createdAt: r.createdAt });

reservationsRouter.get("/", requirePermission("reservations.view"), asyncHandler(async (req, res) => {
  const { tenantId, tenant } = req.auth;
  const today = localParts(tenant.timezone).ymd;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : today;
  const [items, pending, upcoming] = await Promise.all([
    prisma.reservation.findMany({ where: { tenantId, date }, orderBy: { time: "asc" } }),
    prisma.reservation.count({ where: { tenantId, status: "PENDING", date: { gte: today } } }),
    prisma.reservation.count({ where: { tenantId, status: { in: ["PENDING", "CONFIRMED"] }, date: { gte: today } } }),
  ]);
  return ok(res, { date, today, items: items.map(resView), pendingCount: pending, upcomingCount: upcoming });
}));

// A booking taken by phone or in person: confirmed straight away.
reservationsRouter.post("/", requirePermission("reservations.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(slotBody.extend({ tableLabel: z.string().trim().max(20).optional().or(z.literal("")) }), req.body);
  const { tenantId, tenant } = req.auth;
  checkSlot(tenant, await prisma.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } }), b);
  const customer = await customerForGuest(tenantId, { name: b.customerName, phone: b.customerPhone });
  const r = await prisma.reservation.create({ data: { tenantId, publicToken: newToken(), customerName: b.customerName, customerPhone: b.customerPhone, customerId: customer?.id || null, partySize: b.partySize, date: b.date, time: b.time, note: b.note || null, status: "CONFIRMED", tableLabel: b.tableLabel || null } });
  await audit(req, { action: "reservation.created", entityType: "reservation", entityId: r.id, summary: `Booked ${r.customerName} for ${r.partySize} on ${r.date} at ${r.time}` });
  return created(res, resView(r), "Booking added.");
}));

reservationsRouter.patch("/:id/status", requirePermission("reservations.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(["CONFIRMED", "REJECTED", "ARRIVED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"]),
    reason: z.string().trim().max(200).optional(),
    tableLabel: z.string().trim().max(20).optional().or(z.literal("")),
  }), req.body);
  const { tenantId } = req.auth;
  const r = await prisma.reservation.findFirst({ where: { id: req.params.id, tenantId } });
  if (!r) throw notFound("Reservation not found.");
  if (!FLOW[r.status].includes(b.status)) throw conflict(`A ${r.status.toLowerCase().replace("_", " ")} booking can't become ${b.status.toLowerCase().replace("_", " ")}.`);
  if (b.status === "REJECTED" && (!b.reason || b.reason.length < 3)) throw conflict("Tell the guest why (at least 3 characters).");
  const claim = await prisma.reservation.updateMany({ where: { id: r.id, tenantId, status: r.status }, data: { status: b.status, ...(b.reason ? { statusNote: b.reason } : {}), ...(b.tableLabel ? { tableLabel: b.tableLabel } : {}) } });
  if (claim.count === 0) throw conflict("Someone else just updated this booking. Refresh to see the latest.");
  await audit(req, { action: "reservation.status", entityType: "reservation", entityId: r.id, summary: `${r.customerName}'s booking (${r.date} ${r.time}): ${r.status.toLowerCase()} → ${b.status.toLowerCase().replace("_", " ")}${b.reason ? ` (${b.reason})` : ""}` });
  return ok(res, resView(await prisma.reservation.findUnique({ where: { id: r.id } })), "Booking updated.");
}));
