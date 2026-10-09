import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { asyncHandler, badRequest, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { tenantView } from "../auth/views.js";
import { BUSINESS_TYPES } from "../auth/auth.routes.js";

export const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
export const tenantRouter = Router();
tenantRouter.use(authenticate);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use the 24-hour format, e.g. 07:30");
const branchView = (b) => ({ id: b.id, name: b.name, address: b.address, phone: b.phone, opensAt: b.opensAt, closesAt: b.closesAt, isMain: b.isMain });

tenantRouter.get("/", asyncHandler(async (req, res) => {
  const branches = await prisma.branch.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { createdAt: "asc" } });
  return ok(res, { ...tenantView(req.auth.tenant), branches: branches.map(branchView) });
}));

tenantRouter.patch("/", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80),
    businessType: z.enum(BUSINESS_TYPES),
    description: z.string().trim().max(400).optional().or(z.literal("")),
    phone: z.string().trim().min(7).max(20),
    email: z.string().trim().toLowerCase().email().optional().or(z.literal("")),
    address: z.string().trim().max(160).optional().or(z.literal("")),
    city: z.string().trim().max(60).optional().or(z.literal("")),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #155A41"),
    paymentInstructions: z.string().trim().max(400).optional().or(z.literal("")),
    requirePaymentProof: z.boolean().optional(),
    acceptReservations: z.boolean().optional(),
    maxPartySize: z.number().int().min(1).max(100).optional(),
  }), req.body);
  // slug, currency and timezone are deliberately not editable here: the slug is printed on QR codes.
  const updated = await prisma.tenant.update({
    where: { id: req.auth.tenantId },
    data: { name: b.name, businessType: b.businessType, description: b.description || null, phone: b.phone, email: b.email || null, address: b.address || null, city: b.city || null, brandColor: b.brandColor,
      ...(b.paymentInstructions !== undefined ? { paymentInstructions: b.paymentInstructions || null } : {}),
      ...(b.requirePaymentProof !== undefined ? { requirePaymentProof: b.requirePaymentProof } : {}),
      ...(b.acceptReservations !== undefined ? { acceptReservations: b.acceptReservations } : {}),
      ...(b.maxPartySize !== undefined ? { maxPartySize: b.maxPartySize } : {}) },
  });
  await audit(req, { action: "tenant.updated", entityType: "tenant", entityId: updated.id, summary: "Updated the business profile" });
  return ok(res, tenantView(updated), "Business profile saved.");
}));

tenantRouter.patch("/branches/:id", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(60),
    address: z.string().trim().max(160).optional().or(z.literal("")),
    phone: z.string().trim().max(20).optional().or(z.literal("")),
    opensAt: hhmm, closesAt: hhmm,
  }), req.body);
  const branch = await prisma.branch.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId } });
  if (!branch) throw notFound("Branch not found.");
  const updated = await prisma.branch.update({ where: { id: branch.id }, data: { name: b.name, address: b.address || null, phone: b.phone || null, opensAt: b.opensAt, closesAt: b.closesAt } });
  await audit(req, { action: "branch.updated", entityType: "branch", entityId: branch.id, summary: `Updated the branch "${updated.name}"` });
  return ok(res, branchView(updated), "Branch saved.");
}));

// ---- logo upload: tenant-aware storage path, type + size + content checks ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

function sniffImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

tenantRouter.post("/logo", requirePermission("settings.update"), requireActiveSubscription, upload.single("logo"), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest("Choose an image to upload.");
  const ext = sniffImage(req.file.buffer);
  if (!ext) throw badRequest("Upload a PNG, JPG or WebP image.");
  const { tenantId, tenant } = req.auth;
  const rel = `tenants/${tenantId}/logo/${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const abs = path.join(UPLOAD_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, req.file.buffer);
  if (tenant.logoPath) await fs.rm(path.join(UPLOAD_ROOT, tenant.logoPath), { force: true });
  const updated = await prisma.tenant.update({ where: { id: tenantId }, data: { logoPath: rel } });
  await audit(req, { action: "tenant.logo_updated", entityType: "tenant", entityId: tenantId, summary: "Uploaded a new logo" });
  return ok(res, tenantView(updated), "Logo updated.");
}));

tenantRouter.delete("/logo", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId, tenant } = req.auth;
  if (tenant.logoPath) await fs.rm(path.join(UPLOAD_ROOT, tenant.logoPath), { force: true });
  const updated = await prisma.tenant.update({ where: { id: tenantId }, data: { logoPath: null } });
  await audit(req, { action: "tenant.logo_removed", entityType: "tenant", entityId: tenantId, summary: "Removed the logo" });
  return ok(res, tenantView(updated), "Logo removed.");
}));
