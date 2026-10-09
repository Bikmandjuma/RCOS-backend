import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { ok, created } from "../../shared/http.js";
import { AppError, asyncHandler, badRequest, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { hasAccess } from "../billing/subscription.js";
import { logoUrl } from "../auth/views.js";
import { removePrivate, savePrivate, sniffImage } from "../../shared/storage.js";
import { emit, orderView, receiptView } from "../orders/orders.service.js";
import { localParts, priceLines, promoActive, promoView } from "../../shared/promo.js";
import { customerForGuest } from "../customers/customers.service.js";

export const orderingRouter = Router();

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newOrderToken = () => Array.from(crypto.randomBytes(14), (b) => ALPHABET[b % ALPHABET.length]).join("");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const orderLimiter = env.isTest ? (_q, _s, n) => n() : rateLimit({
  // Per device-and-table, not per IP: a whole restaurant shares one Wi-Fi address.
  windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}|${req.params.token}`,
  message: { statusCode: 429, message: "Too many orders from this device. Please wait a few minutes or ask the staff for help." },
});

const restaurantView = (t) => ({ name: t.name, slug: t.slug, logoUrl: logoUrl(t), brandColor: t.brandColor, description: t.description, businessType: t.businessType });

async function menuFor(tenantId) {
  const cats = await prisma.menuCategory.findMany({
    where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { products: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
  });
  return cats.filter((c) => c.products.length).map((c) => ({
    id: c.id, name: c.name,
    products: c.products.map((p) => ({ id: p.id, name: p.name, description: p.description, priceRwf: p.priceRwf, isAvailable: p.isAvailable })),
  }));
}

async function activePromos(tenant) {
  const parts = localParts(tenant.timezone);
  return (await prisma.promotion.findMany({ where: { tenantId: tenant.id, isActive: true } })).filter((p) => promoActive(p, parts));
}
const loyaltyInfo = (t) => ({ enabled: t.loyaltyEnabled, rwfPerPoint: t.loyaltyRwfPerPoint, rewardPoints: t.rewardPoints, rewardName: t.rewardName });

async function loadTable(token) {
  const table = await prisma.diningTable.findUnique({ where: { qrToken: String(token).toUpperCase() }, include: { tenant: { include: { subscription: true } } } });
  if (!table || table.tenant.status !== "ACTIVE") throw notFound("This QR code isn't active. Please ask the staff for help.");
  return table;
}

const acceptance = (table) => {
  if (!table.isActive) return { accepting: false, reason: "This table isn't taking orders right now. Please ask the staff." };
  if (!table.tenant.subscription || !hasAccess(table.tenant.subscription)) return { accepting: false, reason: "Online ordering is paused at the moment. Please order with the staff." };
  return { accepting: true };
};

// Scanning a table QR: resolves to restaurant + table + menu in one call.
orderingRouter.get("/q/:token", asyncHandler(async (req, res) => {
  const table = await loadTable(req.params.token);
  const a = acceptance(table);
  return ok(res, {
    restaurant: restaurantView(table.tenant), table: { label: table.label },
    acceptingOrders: a.accepting, reason: a.reason || null,
    paymentInstructions: table.tenant.paymentInstructions, requireProof: table.tenant.requirePaymentProof,
    promotions: (await activePromos(table.tenant)).map((x) => promoView(x, true)),
    loyalty: loyaltyInfo(table.tenant),
    menu: await menuFor(table.tenantId),
  });
}));

// Read-only menu for the public restaurant page.
orderingRouter.get("/restaurants/:slug/menu", asyncHandler(async (req, res) => {
  const t = await prisma.tenant.findUnique({ where: { slug: String(req.params.slug).toLowerCase() } });
  if (!t || t.status !== "ACTIVE") throw notFound("We couldn't find this restaurant.");
  return ok(res, await menuFor(t.id));
}));

const orderBody = z.object({
  customerName: z.string().trim().min(2, "Enter your name").max(60),
  customerPhone: z.string().trim().max(20).optional().or(z.literal("")),
  note: z.string().trim().max(200).optional().or(z.literal("")),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1, "Quantity must be at least 1").max(20, "Maximum 20 of one item"),
    note: z.string().trim().max(100).optional().or(z.literal("")),
  })).min(1, "Add at least one item").max(30, "That's a lot of items. Please split it into two orders."),
});

function readImage(file) {
  const ext = sniffImage(file.buffer);
  if (!ext) throw badRequest("Upload the payment proof as a PNG, JPG or WebP image (a screenshot of the confirmation works).");
  return ext;
}

async function createWithNumber(data, items) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const m = await tx.order.aggregate({ where: { tenantId: data.tenantId }, _max: { number: true } });
        const o = await tx.order.create({ data: { ...data, number: (m._max.number ?? 1000) + 1, items: { create: items } } });
        await tx.orderStatusEvent.create({ data: { orderId: o.id, toStatus: "PLACED", actorName: data.customerName } });
        return o;
      });
    } catch (e) { if (e.code !== "P2002" || attempt === 5) throw e; }
  }
  return null;
}

orderingRouter.post("/q/:token/orders", orderLimiter, upload.single("proof"), asyncHandler(async (req, res) => {
  const table = await loadTable(req.params.token);
  const a = acceptance(table);
  if (!a.accepting) throw new AppError(403, a.reason, "ORDERING_PAUSED");

  let raw;
  try { raw = JSON.parse(req.body.data || "{}"); } catch { throw badRequest("We couldn't read your order. Please try again."); }
  const b = parse(orderBody, raw);
  const tenant = table.tenant;

  if (tenant.requirePaymentProof && !req.file) throw badRequest("Upload your payment proof to place the order.");
  const ext = req.file ? readImage(req.file) : null;

  // Prices always come from our database — never from the browser.
  const qty = new Map();
  for (const i of b.items) qty.set(i.productId, { q: (qty.get(i.productId)?.q || 0) + i.quantity, note: i.note || null });
  const products = await prisma.product.findMany({ where: { tenantId: tenant.id, id: { in: [...qty.keys()] } } });
  if (products.length !== qty.size) throw conflict("Some items on your order are no longer on the menu. Please refresh and try again.");
  const gone = products.filter((p) => !p.isAvailable);
  if (gone.length) throw conflict(`Sorry, ${gone.map((p) => p.name).join(", ")} ${gone.length > 1 ? "are" : "is"} no longer available.`);
  if ([...qty.values()].some((v) => v.q > 20)) throw badRequest("Maximum 20 of one item.");

  const items = products.map((p) => ({ productId: p.id, name: p.name, unitPriceRwf: p.priceRwf, quantity: qty.get(p.id).q, note: qty.get(p.id).note }));
  // Promotions are applied here, on the server, using the business's own clock — never trusted from the browser.
  const promos = await prisma.promotion.findMany({ where: { tenantId: tenant.id, isActive: true } });
  const catOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const priced = priceLines(items.map((i) => ({ ...i, categoryId: catOf.get(i.productId) })), promos, localParts(tenant.timezone));
  const totalRwf = priced.totalRwf;
  const customer = await customerForGuest(tenant.id, { name: b.customerName, phone: b.customerPhone || "" });
  const proofPath = req.file ? await savePrivate(tenant.id, "proofs", req.file.buffer, ext) : null;

  let order;
  try {
    order = await createWithNumber({
      tenantId: tenant.id, branchId: table.branchId, tableId: table.id, tableLabel: table.label, publicToken: newOrderToken(),
      customerName: b.customerName, customerPhone: b.customerPhone || null, note: b.note || null, totalRwf,
      customerId: customer?.id || null, subtotalRwf: priced.subtotalRwf, discountRwf: priced.discountRwf, promotionName: priced.promotionNames.join(", ") || null,
      proofRequired: tenant.requirePaymentProof, proofPath, paymentStatus: proofPath ? "PROOF_SUBMITTED" : "NOT_REQUIRED",
    }, items);
  } catch (e) { await removePrivate(proofPath); throw e; }

  emit(order, "order.created");
  return created(res, { orderToken: order.publicToken, number: order.number, totalRwf, subtotalRwf: priced.subtotalRwf, discountRwf: priced.discountRwf }, "Order placed.");
}));

// Guest tracking page: the long random token is the only key, so it reveals nothing about other orders.
const trackView = (o, restaurant) => ({
  ...orderView({ ...o, proofPath: o.proofPath, customerPhone: null }), restaurant,
});

async function loadByToken(token) {
  const o = await prisma.order.findUnique({ where: { publicToken: String(token) }, include: { items: true, history: { orderBy: { createdAt: "asc" } }, tenant: true } });
  if (!o) throw notFound("We couldn't find this order.");
  return o;
}

orderingRouter.get("/orders/:token", asyncHandler(async (req, res) => {
  const o = await loadByToken(req.params.token);
  const v = trackView(o, { name: o.tenant.name, brandColor: o.tenant.brandColor, logoUrl: logoUrl(o.tenant), paymentInstructions: o.tenant.paymentInstructions });
  delete v.id; delete v.history; delete v.customerId;
  if (o.customerId && o.tenant.loyaltyEnabled && o.paymentStatus === "CONFIRMED") {
    const c = await prisma.customer.findUnique({ where: { id: o.customerId } });
    v.loyalty = { earned: o.loyaltyAwarded, balance: c?.loyaltyPoints ?? 0, rewardPoints: o.tenant.rewardPoints, rewardName: o.tenant.rewardName };
  }
  const rv = await prisma.review.findUnique({ where: { orderId: o.id } });
  v.review = rv ? { rating: rv.rating, comment: rv.comment } : null;
  return ok(res, v);
}));

// A rejected proof can be replaced by the guest.
orderingRouter.post("/orders/:token/proof", orderLimiter, upload.single("proof"), asyncHandler(async (req, res) => {
  const o = await loadByToken(req.params.token);
  if (o.status === "CANCELLED") throw conflict("This order was cancelled.");
  if (o.paymentStatus !== "REJECTED") throw conflict("Your payment proof doesn't need to be replaced.");
  if (!req.file) throw badRequest("Choose the new payment proof to upload.");
  const ext = readImage(req.file);
  const proofPath = await savePrivate(o.tenantId, "proofs", req.file.buffer, ext);
  const claim = await prisma.order.updateMany({ where: { id: o.id, paymentStatus: "REJECTED" }, data: { proofPath, paymentStatus: "PROOF_SUBMITTED", paymentNote: null } });
  if (claim.count === 0) { await removePrivate(proofPath); throw conflict("Your payment proof doesn't need to be replaced."); }
  await removePrivate(o.proofPath);
  emit({ ...o, paymentStatus: "PROOF_SUBMITTED" });
  return ok(res, { paymentStatus: "PROOF_SUBMITTED" }, "New proof sent. The restaurant will check it.");
}));

orderingRouter.get("/orders/:token/receipt", asyncHandler(async (req, res) => {
  const o = await prisma.order.findUnique({ where: { publicToken: String(req.params.token) }, include: { items: true, refunds: { orderBy: { createdAt: "asc" } }, tenant: true } });
  if (!o) throw notFound("We couldn't find this order.");
  if (o.paymentStatus !== "CONFIRMED") throw conflict("Your receipt is available once the restaurant confirms your payment.");
  return ok(res, receiptView(o, o.tenant, logoUrl(o.tenant)));
}));
