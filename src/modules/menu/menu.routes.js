import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, badRequest, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";

export const menuRouter = Router();
menuRouter.use(authenticate);

const catView = (c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder });
const prodView = (p) => ({ id: p.id, categoryId: p.categoryId, name: p.name, description: p.description, priceRwf: p.priceRwf, isAvailable: p.isAvailable, sortOrder: p.sortOrder });

// Whole menu in one call: categories with their products.
menuRouter.get("/", requirePermission("products.view"), asyncHandler(async (req, res) => {
  const tenantId = req.auth.tenantId;
  const [cats, prods] = await Promise.all([
    prisma.menuCategory.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.product.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  return ok(res, cats.map((c) => ({ ...catView(c), products: prods.filter((p) => p.categoryId === c.id).map(prodView) })));
}));

const catBody = z.object({ name: z.string().trim().min(2, "Enter a category name").max(40) });

menuRouter.post("/categories", requirePermission("products.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(catBody, req.body);
  const { tenantId } = req.auth;
  if (await prisma.menuCategory.findFirst({ where: { tenantId, name: b.name } })) throw conflict("You already have a category with this name.");
  const max = await prisma.menuCategory.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
  const c = await prisma.menuCategory.create({ data: { tenantId, name: b.name, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
  await audit(req, { action: "menu.category_created", entityType: "category", entityId: c.id, summary: `Added the menu category "${c.name}"` });
  return created(res, catView(c), "Category added.");
}));

menuRouter.patch("/categories/:id", requirePermission("products.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(catBody, req.body);
  const { tenantId } = req.auth;
  const c = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId } });
  if (!c) throw notFound("Category not found.");
  const dup = await prisma.menuCategory.findFirst({ where: { tenantId, name: b.name, NOT: { id: c.id } } });
  if (dup) throw conflict("You already have a category with this name.");
  const u = await prisma.menuCategory.update({ where: { id: c.id }, data: { name: b.name } });
  return ok(res, catView(u), "Category renamed.");
}));

menuRouter.delete("/categories/:id", requirePermission("products.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const c = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId }, include: { _count: { select: { products: true } } } });
  if (!c) throw notFound("Category not found.");
  if (c._count.products > 0) throw conflict("Move or delete the items in this category first.");
  await prisma.menuCategory.delete({ where: { id: c.id } });
  await audit(req, { action: "menu.category_deleted", entityType: "category", entityId: c.id, summary: `Deleted the menu category "${c.name}"` });
  return ok(res, null, "Category deleted.");
}));

const prodBody = z.object({
  categoryId: z.string({ required_error: "Choose a category" }).min(1, "Choose a category"),
  name: z.string({ required_error: "Enter an item name" }).trim().min(2, "Enter an item name").max(60),
  description: z.string().trim().max(200).optional().or(z.literal("")),
  priceRwf: z.number({ required_error: "Enter a price", invalid_type_error: "Enter a price" }).int("Use whole francs").min(1, "Price must be at least 1").max(10_000_000),
  isAvailable: z.boolean().optional(),
});

async function ownCategory(tenantId, id) {
  const c = await prisma.menuCategory.findFirst({ where: { id, tenantId } });
  if (!c) throw badRequest("Choose a valid category.");
  return c;
}

menuRouter.post("/products", requirePermission("products.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(prodBody, req.body);
  const { tenantId } = req.auth;
  await ownCategory(tenantId, b.categoryId);
  const max = await prisma.product.aggregate({ where: { tenantId, categoryId: b.categoryId }, _max: { sortOrder: true } });
  const p = await prisma.product.create({ data: { tenantId, categoryId: b.categoryId, name: b.name, description: b.description || null, priceRwf: b.priceRwf, isAvailable: b.isAvailable ?? true, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
  await audit(req, { action: "menu.product_created", entityType: "product", entityId: p.id, summary: `Added "${p.name}" at RWF ${p.priceRwf}` });
  return created(res, prodView(p), "Item added.");
}));

menuRouter.patch("/products/:id", requirePermission("products.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const p = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } });
  if (!p) throw notFound("Item not found.");
  const b = parse(prodBody.partial(), req.body);
  if (b.categoryId) await ownCategory(tenantId, b.categoryId);
  const data = {};
  for (const k of ["categoryId", "name", "priceRwf", "isAvailable"]) if (b[k] !== undefined) data[k] = b[k];
  if (b.description !== undefined) data.description = b.description || null;
  const u = await prisma.product.update({ where: { id: p.id }, data });
  const notes = [];
  if (data.priceRwf !== undefined && data.priceRwf !== p.priceRwf) notes.push(`price RWF ${p.priceRwf} → ${data.priceRwf}`);
  if (data.isAvailable !== undefined && data.isAvailable !== p.isAvailable) notes.push(data.isAvailable ? "marked available" : "marked unavailable");
  if (data.name && data.name !== p.name) notes.push(`renamed from "${p.name}"`);
  if (notes.length) await audit(req, { action: "menu.product_updated", entityType: "product", entityId: p.id, summary: `"${u.name}": ${notes.join(", ")}` });
  return ok(res, prodView(u), "Item saved.");
}));

// Past orders keep their own copy of name and price, so deleting an item never rewrites history.
menuRouter.delete("/products/:id", requirePermission("products.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const p = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } });
  if (!p) throw notFound("Item not found.");
  await prisma.product.delete({ where: { id: p.id } });
  await audit(req, { action: "menu.product_deleted", entityType: "product", entityId: p.id, summary: `Deleted "${p.name}"` });
  return ok(res, null, "Item deleted.");
}));
