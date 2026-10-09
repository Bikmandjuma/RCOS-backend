import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { publicBase } from "../tenants/domains.service.js";
import { env } from "../../config/env.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";

export const tablesRouter = Router();
tablesRouter.use(authenticate);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (0/O, 1/I)
const newToken = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

const view = (t, base) => ({ id: t.id, label: t.label, isActive: t.isActive, qrToken: t.qrToken, qrUrl: `${base}/q/${t.qrToken}` });

tablesRouter.get("/", requirePermission("tables.view"), asyncHandler(async (req, res) => {
  const list = await prisma.diningTable.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { createdAt: "asc" } });
  return ok(res, list.map((t) => view(t, publicBase(req.auth.tenant))));
}));

// Add one table or a run of them: prefix "T", count 10 -> T01…T10.
tablesRouter.post("/", requirePermission("tables.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    prefix: z.string().trim().max(12).default("T"),
    count: z.number().int().min(1).max(100),
    start: z.number().int().min(1).max(999).default(1),
  }), req.body);
  const { tenantId } = req.auth;
  const branch = await prisma.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  const pad = Math.max(2, String(b.start + b.count - 1).length);
  const labels = Array.from({ length: b.count }, (_, i) => `${b.prefix}${String(b.start + i).padStart(pad, "0")}`);
  const existing = await prisma.diningTable.findMany({ where: { tenantId, branchId: branch.id, label: { in: labels } }, select: { label: true } });
  if (existing.length) throw conflict(`These tables already exist: ${existing.map((e) => e.label).join(", ")}. Choose a different start number.`);
  const made = await prisma.$transaction(labels.map((label) => prisma.diningTable.create({ data: { tenantId, branchId: branch.id, label, qrToken: newToken() } })));
  await audit(req, { action: "table.created", entityType: "table", summary: `Added ${made.length} table${made.length === 1 ? "" : "s"} (${labels[0]}${labels.length > 1 ? `–${labels.at(-1)}` : ""})` });
  return created(res, made.map((t) => view(t, publicBase(req.auth.tenant))), "Tables added.");
}));

tablesRouter.patch("/:id", requirePermission("tables.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ label: z.string().trim().min(1).max(20).optional(), isActive: z.boolean().optional() }), req.body);
  const { tenantId } = req.auth;
  const t = await prisma.diningTable.findFirst({ where: { id: req.params.id, tenantId } });
  if (!t) throw notFound("Table not found.");
  if (b.label && b.label !== t.label && (await prisma.diningTable.findFirst({ where: { branchId: t.branchId, label: b.label } }))) throw conflict("A table with this name already exists.");
  const u = await prisma.diningTable.update({ where: { id: t.id }, data: b });
  await audit(req, { action: "table.updated", entityType: "table", entityId: t.id, summary: `Updated table ${u.label}${b.isActive === false ? " (turned off)" : b.isActive === true ? " (turned on)" : ""}` });
  return ok(res, view(u, publicBase(req.auth.tenant)), "Table saved.");
}));

// A table that has taken orders is turned off, never deleted: orders keep their table name either way.
tablesRouter.delete("/:id", requirePermission("tables.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const t = await prisma.diningTable.findFirst({ where: { id: req.params.id, tenantId } });
  if (!t) throw notFound("Table not found.");
  const used = await prisma.order.count({ where: { tenantId, tableId: t.id } });
  if (used) throw conflict("This table has past orders, so it can't be deleted. Turn it off instead.");
  await prisma.diningTable.delete({ where: { id: t.id } });
  await audit(req, { action: "table.deleted", entityType: "table", entityId: t.id, summary: `Deleted table ${t.label}` });
  return ok(res, null, "Table deleted.");
}));
