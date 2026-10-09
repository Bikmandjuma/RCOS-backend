import { prisma } from "../../shared/db.js";

export const UNITS = ["G", "ML", "PCS"];
const DAY = 86_400_000;

export const statusOf = (i) => (i.quantity <= 0 ? "OUT" : i.lowStockAt > 0 && i.quantity <= i.lowStockAt ? "LOW" : "OK");

/**
 * Change an ingredient's stock and record why. Stock is only ever changed through here, so the
 * movement history always adds up to the current quantity. `ingredientId` must already be
 * verified as belonging to the tenant by the caller.
 */
export async function moveStock(tenantId, ingredientId, delta, { type, reason, orderId, purchaseId, actor, data = {} }) {
  const upd = await prisma.ingredient.update({ where: { id: ingredientId }, data: { quantity: { increment: delta }, ...data } });
  await prisma.stockMovement.create({
    data: { tenantId, ingredientId, type, quantity: delta, balanceAfter: upd.quantity, reason: reason || null, orderId: orderId || null, purchaseId: purchaseId || null, actorId: actor?.id || null, actorName: actor?.fullName || null },
  });
  return upd;
}

/** Average daily use over the last 14 days (or the ingredient's age if newer) → rough "days left". */
export async function usageByIngredient(tenantId, ingredients) {
  const since = new Date(Date.now() - 14 * DAY);
  const rows = await prisma.stockMovement.groupBy({ by: ["ingredientId"], where: { tenantId, type: "SALE", createdAt: { gte: since } }, _sum: { quantity: true } });
  const used = new Map(rows.map((r) => [r.ingredientId, -(r._sum.quantity || 0)]));
  const out = new Map();
  for (const i of ingredients) {
    const days = Math.min(14, Math.max(1, Math.ceil((Date.now() - i.createdAt.getTime()) / DAY)));
    const daily = (used.get(i.id) || 0) / days;
    out.set(i.id, { dailyUse: Math.round(daily), daysLeft: daily > 0 && i.quantity > 0 ? Math.floor(i.quantity / daily) : null });
  }
  return out;
}

export const ingredientView = (i, usage) => ({
  id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, lowStockAt: i.lowStockAt, unitCostRwf: i.unitCostRwf,
  status: statusOf(i), dailyUse: usage?.dailyUse ?? 0, daysLeft: usage?.daysLeft ?? null,
  stockValueRwf: Math.round(Math.max(0, i.quantity) * i.unitCostRwf),
});

/**
 * Called when the kitchen starts an order: take each item's recipe out of stock, once.
 * Never blocks the kitchen — a shortage shows as low/out of stock, not as a refused order.
 */
export async function deductStockForOrder(order, actor) {
  const { id: orderId, tenantId } = order;
  const claim = await prisma.order.updateMany({ where: { id: orderId, tenantId, stockDeducted: false }, data: { stockDeducted: true } });
  if (claim.count === 0) return { deducted: false };
  try {
    const items = order.items || (await prisma.orderItem.findMany({ where: { orderId } }));
    const productIds = items.map((i) => i.productId).filter(Boolean);
    if (!productIds.length) return { deducted: true, lines: 0 };
    const recipe = await prisma.recipeItem.findMany({ where: { tenantId, productId: { in: productIds } } });
    const use = new Map();
    for (const item of items) for (const r of recipe.filter((x) => x.productId === item.productId)) use.set(r.ingredientId, (use.get(r.ingredientId) || 0) + r.quantity * item.quantity);
    for (const [ingredientId, qty] of use) await moveStock(tenantId, ingredientId, -qty, { type: "SALE", orderId, reason: `Order #${order.number}`, actor });
    return { deducted: true, lines: use.size };
  } catch (e) {
    await prisma.order.updateMany({ where: { id: orderId, tenantId }, data: { stockDeducted: false } }); // allow a retry
    console.error("[inventory] stock deduction failed for order", orderId, e.message);
    return { deducted: false, error: true };
  }
}
