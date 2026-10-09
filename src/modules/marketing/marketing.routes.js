import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, badRequest, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { localParts, promoActive, promoView } from "../../shared/promo.js";

export const marketingRouter = Router();
marketingRouter.use(authenticate);

const loyaltyView = (t) => ({ enabled: t.loyaltyEnabled, rwfPerPoint: t.loyaltyRwfPerPoint, rewardPoints: t.rewardPoints, rewardName: t.rewardName });

marketingRouter.get("/loyalty", requirePermission("promotions.view"), (req, res) => ok(res, loyaltyView(req.auth.tenant)));

marketingRouter.put("/loyalty", requirePermission("promotions.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    enabled: z.boolean(),
    rwfPerPoint: z.number({ invalid_type_error: "Enter a number" }).int().min(1, "At least 1").max(1_000_000),
    rewardPoints: z.number({ invalid_type_error: "Enter a number" }).int().min(1, "At least 1").max(10_000_000),
    rewardName: z.string().trim().max(60).optional().or(z.literal("")),
  }), req.body);
  if (b.enabled && !b.rewardName) throw badRequest("Name the reward (for example: Free cappuccino) before switching loyalty on.");
  const t = await prisma.tenant.update({ where: { id: req.auth.tenantId }, data: { loyaltyEnabled: b.enabled, loyaltyRwfPerPoint: b.rwfPerPoint, rewardPoints: b.rewardPoints, rewardName: b.rewardName || null } });
  await audit(req, { action: "loyalty.settings", entityType: "tenant", summary: b.enabled ? `Loyalty on: 1 point per RWF ${b.rwfPerPoint}, ${b.rewardPoints} points = ${b.rewardName}` : "Switched the loyalty programme off" });
  return ok(res, loyaltyView(t), "Loyalty settings saved.");
}));

// ---------- promotions ----------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the 24-hour format, e.g. 15:00");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31");
const promoBody = z.object({
  name: z.string({ required_error: "Name the promotion" }).trim().min(2, "Name the promotion").max(60),
  percent: z.number({ required_error: "Enter a percentage", invalid_type_error: "Enter a percentage" }).int("Use a whole number").min(1, "At least 1%").max(90, "At most 90%"),
  categoryId: z.string().nullable().optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  startTime: hhmm.nullable().optional(), endTime: hhmm.nullable().optional(),
  startDate: ymd.nullable().optional(), endDate: ymd.nullable().optional(),
  isActive: z.boolean().optional(),
});

async function clean(tenantId, b) {
  if (!!b.startTime !== !!b.endTime) throw badRequest("Set both a start and an end time, or neither.");
  if (b.startDate && b.endDate && b.endDate < b.startDate) throw badRequest("The end date can't be before the start date.");
  if (b.categoryId && !(await prisma.menuCategory.findFirst({ where: { id: b.categoryId, tenantId } }))) throw badRequest("Choose a category from your menu.");
  const days = b.days && b.days.length && b.days.length < 7 ? [...new Set(b.days)].sort().join(",") : null;
  return { name: b.name, percent: b.percent, categoryId: b.categoryId || null, days, startTime: b.startTime || null, endTime: b.endTime || null, startDate: b.startDate || null, endDate: b.endDate || null, isActive: b.isActive ?? true };
}

marketingRouter.get("/promotions", requirePermission("promotions.view"), asyncHandler(async (req, res) => {
  const list = await prisma.promotion.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { createdAt: "desc" } });
  const parts = localParts(req.auth.tenant.timezone);
  return ok(res, list.map((p) => promoView(p, promoActive(p, parts))));
}));

marketingRouter.post("/promotions", requirePermission("promotions.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(promoBody, req.body);
  const p = await prisma.promotion.create({ data: { tenantId: req.auth.tenantId, ...(await clean(req.auth.tenantId, b)) } });
  await audit(req, { action: "promotion.created", entityType: "promotion", entityId: p.id, summary: `Created the promotion "${p.name}" (${p.percent}% off)` });
  return created(res, promoView(p), "Promotion created.");
}));

marketingRouter.patch("/promotions/:id", requirePermission("promotions.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const cur = await prisma.promotion.findFirst({ where: { id: req.params.id, tenantId } });
  if (!cur) throw notFound("Promotion not found.");
  const b = parse(promoBody.partial(), req.body);
  const merged = { name: cur.name, percent: cur.percent, categoryId: cur.categoryId, days: cur.days ? cur.days.split(",").map(Number) : null, startTime: cur.startTime, endTime: cur.endTime, startDate: cur.startDate, endDate: cur.endDate, isActive: cur.isActive, ...b };
  const p = await prisma.promotion.update({ where: { id: cur.id }, data: await clean(tenantId, merged) });
  await audit(req, { action: "promotion.updated", entityType: "promotion", entityId: p.id, summary: `Updated the promotion "${p.name}"${b.isActive === false ? " (turned off)" : b.isActive === true ? " (turned on)" : ""}` });
  return ok(res, promoView(p), "Promotion saved.");
}));

marketingRouter.delete("/promotions/:id", requirePermission("promotions.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const cur = await prisma.promotion.findFirst({ where: { id: req.params.id, tenantId } });
  if (!cur) throw notFound("Promotion not found.");
  await prisma.promotion.delete({ where: { id: cur.id } });
  await audit(req, { action: "promotion.deleted", entityType: "promotion", entityId: cur.id, summary: `Deleted the promotion "${cur.name}"` });
  return ok(res, null, "Promotion deleted.");
}));
