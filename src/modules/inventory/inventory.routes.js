import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, badRequest, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { UNITS, ingredientView, moveStock, statusOf, usageByIngredient } from "./stock.service.js";

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

const qty = (label = "Quantity") => z.number({ required_error: `Enter the ${label.toLowerCase()}`, invalid_type_error: `Enter the ${label.toLowerCase()}` }).int("Use whole numbers (grams, millilitres or pieces)").min(1, `${label} must be at least 1`).max(1_000_000_000);
const unit = UNITS.length ? z.enum(UNITS, { errorMap: () => ({ message: "Choose grams, millilitres or pieces" }) }) : null;
const unitLabel = { G: ["g", "kg"], ML: ["ml", "L"], PCS: ["pcs", null] };
// Same wording as the app: 4700 ml reads "4.7 L", 700 ml reads "700 ml".
const fmtQty = (n, u) => {
  const [base, big] = unitLabel[u];
  return big && Math.abs(n) >= 1000 ? `${Number((n / 1000).toFixed(2))} ${big}` : `${n.toLocaleString("en-US")} ${base}`;
};

async function ownIngredient(tenantId, id) {
  const i = await prisma.ingredient.findFirst({ where: { id, tenantId } });
  if (!i) throw notFound("Ingredient not found.");
  return i;
}

// ---------- ingredients ----------
inventoryRouter.get("/ingredients", requirePermission("inventory.view"), asyncHandler(async (req, res) => {
  const list = await prisma.ingredient.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { name: "asc" } });
  const usage = await usageByIngredient(req.auth.tenantId, list);
  return ok(res, list.map((i) => ingredientView(i, usage.get(i.id))));
}));

inventoryRouter.get("/summary", requirePermission("inventory.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const list = await prisma.ingredient.findMany({ where: { tenantId } });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const waste = await prisma.stockMovement.groupBy({ by: ["ingredientId"], where: { tenantId, type: "WASTE", createdAt: { gte: since } }, _sum: { quantity: true }, _count: true });
  const cost = new Map(list.map((i) => [i.id, i.unitCostRwf]));
  return ok(res, {
    ingredientCount: list.length,
    lowCount: list.filter((i) => statusOf(i) === "LOW").length,
    outCount: list.filter((i) => statusOf(i) === "OUT").length,
    stockValueRwf: Math.round(list.reduce((n, i) => n + Math.max(0, i.quantity) * i.unitCostRwf, 0)),
    waste30d: { count: waste.reduce((n, w) => n + w._count, 0), costRwf: Math.round(waste.reduce((n, w) => n + -(w._sum.quantity || 0) * (cost.get(w.ingredientId) || 0), 0)) },
  });
}));

const ingBody = z.object({
  name: z.string({ required_error: "Enter a name" }).trim().min(2, "Enter a name").max(60),
  unit: unit,
  lowStockAt: z.number().int().min(0).max(1_000_000_000).default(0),
  unitCostRwf: z.number().min(0).max(10_000_000).default(0),
  openingQuantity: z.number().int().min(0).max(1_000_000_000).default(0),
});

inventoryRouter.post("/ingredients", requirePermission("inventory.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(ingBody, req.body);
  const { tenantId } = req.auth;
  if (await prisma.ingredient.findFirst({ where: { tenantId, name: b.name } })) throw conflict("You already have an ingredient with this name.");
  const i = await prisma.ingredient.create({ data: { tenantId, name: b.name, unit: b.unit, lowStockAt: b.lowStockAt, unitCostRwf: b.unitCostRwf } });
  let fresh = i;
  if (b.openingQuantity > 0) fresh = await moveStock(tenantId, i.id, b.openingQuantity, { type: "ADJUSTMENT", reason: "Opening stock", actor: req.auth.user });
  await audit(req, { action: "inventory.ingredient_created", entityType: "ingredient", entityId: i.id, summary: `Added the ingredient "${i.name}"${b.openingQuantity ? ` with ${fmtQty(b.openingQuantity, i.unit)} in stock` : ""}` });
  return created(res, ingredientView(fresh), "Ingredient added.");
}));

inventoryRouter.patch("/ingredients/:id", requirePermission("inventory.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(ingBody.pick({ name: true, lowStockAt: true, unitCostRwf: true }).partial(), req.body);
  const { tenantId } = req.auth;
  const cur = await ownIngredient(tenantId, req.params.id);
  if (b.name && b.name !== cur.name && (await prisma.ingredient.findFirst({ where: { tenantId, name: b.name } }))) throw conflict("You already have an ingredient with this name.");
  const u = await prisma.ingredient.update({ where: { id: cur.id }, data: b });
  await audit(req, { action: "inventory.ingredient_updated", entityType: "ingredient", entityId: cur.id, summary: `Updated the ingredient "${u.name}"` });
  return ok(res, ingredientView(u), "Ingredient saved.");
}));

inventoryRouter.delete("/ingredients/:id", requirePermission("inventory.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const cur = await ownIngredient(tenantId, req.params.id);
  const used = await prisma.recipeItem.count({ where: { tenantId, ingredientId: cur.id } });
  if (used) throw conflict(`"${cur.name}" is used in ${used} recipe${used === 1 ? "" : "s"}. Remove it from those recipes first.`);
  await prisma.ingredient.delete({ where: { id: cur.id } });
  await audit(req, { action: "inventory.ingredient_deleted", entityType: "ingredient", entityId: cur.id, summary: `Deleted the ingredient "${cur.name}"` });
  return ok(res, null, "Ingredient deleted.");
}));

// ---------- waste & counts ----------
inventoryRouter.post("/ingredients/:id/waste", requirePermission("inventory.adjust"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ quantity: qty(), reason: z.string({ required_error: "Say what happened" }).trim().min(3, "Say what happened (at least 3 characters)").max(120) }), req.body);
  const { tenantId, user } = req.auth;
  const cur = await ownIngredient(tenantId, req.params.id);
  // Guarded: you can't throw away more than you have, even with two people recording at once.
  const claim = await prisma.ingredient.updateMany({ where: { id: cur.id, tenantId, quantity: { gte: b.quantity } }, data: { quantity: { decrement: b.quantity } } });
  if (claim.count === 0) throw conflict(`You only have ${fmtQty(Math.max(0, cur.quantity), cur.unit)} of ${cur.name} in stock.`);
  const after = await prisma.ingredient.findUnique({ where: { id: cur.id } });
  await prisma.stockMovement.create({ data: { tenantId, ingredientId: cur.id, type: "WASTE", quantity: -b.quantity, balanceAfter: after.quantity, reason: b.reason, actorId: user.id, actorName: user.fullName } });
  await audit(req, { action: "inventory.waste", entityType: "ingredient", entityId: cur.id, summary: `Recorded waste: ${fmtQty(b.quantity, cur.unit)} of ${cur.name} (${b.reason})` });
  return ok(res, ingredientView(after), "Waste recorded.");
}));

// A physical count: set the stock to what was actually counted. The difference is kept as an adjustment.
inventoryRouter.post("/ingredients/:id/count", requirePermission("inventory.adjust"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ quantity: z.number({ required_error: "Enter the counted amount", invalid_type_error: "Enter the counted amount" }).int().min(0).max(1_000_000_000), note: z.string().trim().max(120).optional().or(z.literal("")) }), req.body);
  const { tenantId, user } = req.auth;
  const cur = await ownIngredient(tenantId, req.params.id);
  const delta = b.quantity - cur.quantity;
  if (delta === 0) return ok(res, ingredientView(cur), "Stock already matches your count.");
  const claim = await prisma.ingredient.updateMany({ where: { id: cur.id, tenantId, quantity: cur.quantity }, data: { quantity: b.quantity } });
  if (claim.count === 0) throw conflict("The stock just changed. Please count again.");
  await prisma.stockMovement.create({ data: { tenantId, ingredientId: cur.id, type: "ADJUSTMENT", quantity: delta, balanceAfter: b.quantity, reason: b.note || "Stock count", actorId: user.id, actorName: user.fullName } });
  await audit(req, { action: "inventory.count", entityType: "ingredient", entityId: cur.id, summary: `Stock count for ${cur.name}: ${fmtQty(cur.quantity, cur.unit)} → ${fmtQty(b.quantity, cur.unit)}` });
  return ok(res, ingredientView(await prisma.ingredient.findUnique({ where: { id: cur.id } })), "Stock updated.");
}));

inventoryRouter.get("/movements", requirePermission("inventory.view"), asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const where = { tenantId, ...(req.query.ingredientId ? { ingredientId: String(req.query.ingredientId) } : {}), ...(["PURCHASE", "SALE", "WASTE", "ADJUSTMENT"].includes(req.query.type) ? { type: req.query.type } : {}) };
  const [total, rows] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({ where, include: { ingredient: { select: { name: true, unit: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return ok(res, { total, page, pageSize, items: rows.map((m) => ({ id: m.id, type: m.type, quantity: m.quantity, balanceAfter: m.balanceAfter, reason: m.reason, by: m.actorName, at: m.createdAt, ingredient: m.ingredient.name, unit: m.ingredient.unit })) });
}));

// ---------- suppliers ----------
const supView = (s) => ({ id: s.id, name: s.name, phone: s.phone, notes: s.notes });
const supBody = z.object({ name: z.string({ required_error: "Enter a name" }).trim().min(2, "Enter a name").max(60), phone: z.string().trim().max(20).optional().or(z.literal("")), notes: z.string().trim().max(200).optional().or(z.literal("")) });

inventoryRouter.get("/suppliers", requirePermission("suppliers.view"), asyncHandler(async (req, res) => {
  const list = await prisma.supplier.findMany({ where: { tenantId: req.auth.tenantId }, orderBy: { name: "asc" } });
  return ok(res, list.map(supView));
}));
inventoryRouter.post("/suppliers", requirePermission("suppliers.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(supBody, req.body); const { tenantId } = req.auth;
  if (await prisma.supplier.findFirst({ where: { tenantId, name: b.name } })) throw conflict("You already have a supplier with this name.");
  const s = await prisma.supplier.create({ data: { tenantId, name: b.name, phone: b.phone || null, notes: b.notes || null } });
  await audit(req, { action: "supplier.created", entityType: "supplier", entityId: s.id, summary: `Added the supplier "${s.name}"` });
  return created(res, supView(s), "Supplier added.");
}));
inventoryRouter.patch("/suppliers/:id", requirePermission("suppliers.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(supBody, req.body); const { tenantId } = req.auth;
  const s = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
  if (!s) throw notFound("Supplier not found.");
  if (b.name !== s.name && (await prisma.supplier.findFirst({ where: { tenantId, name: b.name } }))) throw conflict("You already have a supplier with this name.");
  return ok(res, supView(await prisma.supplier.update({ where: { id: s.id }, data: { name: b.name, phone: b.phone || null, notes: b.notes || null } })), "Supplier saved.");
}));
inventoryRouter.delete("/suppliers/:id", requirePermission("suppliers.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const s = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } });
  if (!s) throw notFound("Supplier not found.");
  if (await prisma.purchase.count({ where: { tenantId, supplierId: s.id } })) throw conflict("This supplier has recorded purchases, so it can't be deleted.");
  await prisma.supplier.delete({ where: { id: s.id } });
  await audit(req, { action: "supplier.deleted", entityType: "supplier", entityId: s.id, summary: `Deleted the supplier "${s.name}"` });
  return ok(res, null, "Supplier deleted.");
}));

// ---------- purchases (goods received) ----------
inventoryRouter.get("/purchases", requirePermission("inventory.view"), asyncHandler(async (req, res) => {
  const list = await prisma.purchase.findMany({ where: { tenantId: req.auth.tenantId }, include: { items: true }, orderBy: { createdAt: "desc" }, take: 50 });
  return ok(res, list.map((p) => ({ id: p.id, supplier: p.supplierName, totalRwf: p.totalRwf, note: p.note, by: p.actorName, at: p.createdAt, items: p.items.map((i) => ({ ingredient: i.ingredientName, quantity: i.quantity, totalCostRwf: i.totalCostRwf })) })));
}));

inventoryRouter.post("/purchases", requirePermission("inventory.adjust"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({
    supplierId: z.string().optional().or(z.literal("")),
    note: z.string().trim().max(200).optional().or(z.literal("")),
    items: z.array(z.object({ ingredientId: z.string().min(1), quantity: qty(), totalCostRwf: z.number({ required_error: "Enter what you paid", invalid_type_error: "Enter what you paid" }).int("Use whole francs").min(0).max(1_000_000_000) })).min(1, "Add at least one item").max(40),
  }), req.body);
  const { tenantId, user } = req.auth;
  const supplier = b.supplierId ? await prisma.supplier.findFirst({ where: { id: b.supplierId, tenantId } }) : null;
  if (b.supplierId && !supplier) throw badRequest("Choose a valid supplier.");
  const ids = [...new Set(b.items.map((i) => i.ingredientId))];
  const ings = await prisma.ingredient.findMany({ where: { tenantId, id: { in: ids } } });
  if (ings.length !== ids.length) throw badRequest("One of the ingredients doesn't exist. Refresh and try again.");
  const byId = new Map(ings.map((i) => [i.id, i]));
  const total = b.items.reduce((n, i) => n + i.totalCostRwf, 0);
  const p = await prisma.purchase.create({
    data: { tenantId, supplierId: supplier?.id || null, supplierName: supplier?.name || null, totalRwf: total, note: b.note || null, actorId: user.id, actorName: user.fullName,
      items: { create: b.items.map((i) => ({ ingredientId: i.ingredientId, ingredientName: byId.get(i.ingredientId).name, quantity: i.quantity, totalCostRwf: i.totalCostRwf })) } },
  });
  for (const i of b.items) {
    // Latest purchase price becomes the cost used for recipes and margins.
    await moveStock(tenantId, i.ingredientId, i.quantity, { type: "PURCHASE", reason: supplier ? `From ${supplier.name}` : "Purchase", purchaseId: p.id, actor: user, data: i.totalCostRwf > 0 ? { unitCostRwf: i.totalCostRwf / i.quantity } : {} });
  }
  await audit(req, { action: "inventory.purchase", entityType: "purchase", entityId: p.id, summary: `Recorded a purchase of ${b.items.length} item${b.items.length === 1 ? "" : "s"} (RWF ${total.toLocaleString("en-US")})${supplier ? ` from ${supplier.name}` : ""}` });
  return created(res, { id: p.id, totalRwf: total }, "Purchase recorded and stock updated.");
}));

// ---------- recipes ----------
inventoryRouter.get("/recipes", requirePermission("inventory.view"), asyncHandler(async (req, res) => {
  const rows = await prisma.recipeItem.findMany({ where: { tenantId: req.auth.tenantId }, include: { ingredient: true } });
  const by = new Map();
  for (const r of rows) {
    const cur = by.get(r.productId) || { productId: r.productId, costRwf: 0, items: [] };
    cur.items.push({ ingredientId: r.ingredientId, name: r.ingredient.name, unit: r.ingredient.unit, quantity: r.quantity });
    cur.costRwf += r.quantity * r.ingredient.unitCostRwf;
    by.set(r.productId, cur);
  }
  return ok(res, [...by.values()].map((r) => ({ ...r, costRwf: Math.round(r.costRwf) })));
}));

inventoryRouter.put("/recipes/:productId", requirePermission("inventory.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ items: z.array(z.object({ ingredientId: z.string().min(1), quantity: qty("Amount") })).max(25) }), req.body);
  const { tenantId } = req.auth;
  const product = await prisma.product.findFirst({ where: { id: req.params.productId, tenantId } });
  if (!product) throw notFound("Item not found.");
  const ids = b.items.map((i) => i.ingredientId);
  if (new Set(ids).size !== ids.length) throw badRequest("Each ingredient can only appear once in a recipe.");
  const ings = await prisma.ingredient.findMany({ where: { tenantId, id: { in: ids } } });
  if (ings.length !== ids.length) throw badRequest("One of the ingredients doesn't exist. Refresh and try again.");
  await prisma.$transaction([
    prisma.recipeItem.deleteMany({ where: { tenantId, productId: product.id } }),
    prisma.recipeItem.createMany({ data: b.items.map((i) => ({ tenantId, productId: product.id, ingredientId: i.ingredientId, quantity: i.quantity })) }),
  ]);
  const cost = Math.round(b.items.reduce((n, i) => n + i.quantity * ings.find((x) => x.id === i.ingredientId).unitCostRwf, 0));
  await audit(req, { action: "inventory.recipe", entityType: "product", entityId: product.id, summary: b.items.length ? `Set the recipe for "${product.name}" (${b.items.length} ingredient${b.items.length === 1 ? "" : "s"})` : `Removed the recipe for "${product.name}"` });
  return ok(res, { productId: product.id, costRwf: cost, items: b.items }, b.items.length ? "Recipe saved." : "Recipe removed.");
}));
