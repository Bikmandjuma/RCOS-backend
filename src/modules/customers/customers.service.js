import { prisma } from "../../shared/db.js";
import { normalizePhone } from "../../shared/phone.js";
import { segmentFor } from "../../shared/promo.js";

/** Find or create the customer behind an order, matched by phone number. No phone → no customer record. */
export async function customerForGuest(tenantId, { name, phone }) {
  const key = normalizePhone(phone);
  if (!key) return null;
  const found = await prisma.customer.findUnique({ where: { tenantId_phoneKey: { tenantId, phoneKey: key } } });
  if (found) return found;
  try {
    return await prisma.customer.create({ data: { tenantId, name, phone: phone.trim(), phoneKey: key } });
  } catch (e) {
    if (e.code === "P2002") return prisma.customer.findUnique({ where: { tenantId_phoneKey: { tenantId, phoneKey: key } } }); // created a moment ago by another request
    throw e;
  }
}

async function logPoints(tenantId, customerId, orderId, type, points, balanceAfter, note, actorName) {
  await prisma.loyaltyTransaction.create({ data: { tenantId, customerId, orderId: orderId || null, type, points, balanceAfter, note: note || null, actorName: actorName || null } });
}

/** Points are earned once per order, when its payment is confirmed or recorded. */
export async function awardLoyalty(order, tenant) {
  if (!tenant.loyaltyEnabled || !order.customerId) return 0;
  const points = Math.floor(order.totalRwf / Math.max(1, tenant.loyaltyRwfPerPoint));
  if (points <= 0) return 0;
  const claim = await prisma.order.updateMany({ where: { id: order.id, tenantId: order.tenantId, loyaltyAwarded: 0 }, data: { loyaltyAwarded: points } });
  if (claim.count === 0) return 0;
  const c = await prisma.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: points } } });
  await logPoints(order.tenantId, c.id, order.id, "EARN", points, c.loyaltyPoints, `Order #${order.number}`);
  return points;
}

/** A refund takes back the points that money earned (never more than the order awarded). */
export async function reverseLoyalty(order, refundRwf, tenant) {
  if (!order.customerId || !order.loyaltyAwarded) return 0;
  const want = Math.floor(refundRwf / Math.max(1, tenant.loyaltyRwfPerPoint));
  const take = Math.min(want, order.loyaltyAwarded);
  if (take <= 0) return 0;
  const claim = await prisma.order.updateMany({ where: { id: order.id, tenantId: order.tenantId, loyaltyAwarded: { gte: take } }, data: { loyaltyAwarded: { decrement: take } } });
  if (claim.count === 0) return 0;
  const cur = await prisma.customer.findUnique({ where: { id: order.customerId } });
  const newBal = Math.max(0, cur.loyaltyPoints - take);
  await prisma.customer.update({ where: { id: cur.id }, data: { loyaltyPoints: newBal } });
  await logPoints(order.tenantId, cur.id, order.id, "REVERSE", -(cur.loyaltyPoints - newBal), newBal, `Refund on order #${order.number}`);
  return take;
}

/** Paid-order stats for a set of customers, in one query. */
export async function statsFor(tenantId, ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.order.groupBy({
    by: ["customerId"], where: { tenantId, customerId: { in: ids }, paymentStatus: "CONFIRMED", status: { not: "CANCELLED" } },
    _count: true, _sum: { totalRwf: true, refundedRwf: true }, _max: { paidAt: true },
  });
  return new Map(rows.map((r) => [r.customerId, { paidOrders: r._count, spentRwf: (r._sum.totalRwf || 0) - (r._sum.refundedRwf || 0), lastPaidAt: r._max.paidAt }]));
}

export const withSegment = (c, s) => {
  const st = s || { paidOrders: 0, spentRwf: 0, lastPaidAt: null };
  return { id: c.id, name: c.name, phone: c.phone, email: c.email, notes: c.notes, loyaltyPoints: c.loyaltyPoints, createdAt: c.createdAt, paidOrders: st.paidOrders, spentRwf: st.spentRwf, lastPaidAt: st.lastPaidAt, segment: segmentFor(st) };
};
