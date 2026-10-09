import { prisma } from "../../shared/db.js";
import { AppError, forbidden, notFound, conflict } from "../../shared/errors.js";
import { publish } from "../../shared/events.js";
import { audit } from "../../shared/audit.js";
import { deductStockForOrder } from "../inventory/stock.service.js";

// Order lifecycle (PDF §11): PLACED → PREPARING → READY → SERVED → COMPLETED, or CANCELLED.
// Orders are never deleted: every change is a status event.
export const FLOW = {
  PLACED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["SERVED", "CANCELLED"],
  SERVED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export const ACTIVE = ["PLACED", "PREPARING", "READY", "SERVED"];
export const paymentOk = (o) => o.paymentStatus === "CONFIRMED" || o.paymentStatus === "NOT_REQUIRED";

// Who may make which move. Kitchen staff and order staff can both start/finish preparing.
function permissionFor(from, to) {
  if (to === "CANCELLED") return ["orders.cancel"];
  if (from === "PLACED" || from === "PREPARING") return ["kitchen.update", "orders.update"];
  return ["orders.update"];
}

export const orderView = (o, { items = true } = {}) => ({
  id: o.id, number: o.number, status: o.status, paymentStatus: o.paymentStatus, paymentNote: o.paymentNote,
  tableLabel: o.tableLabel, customerName: o.customerName, customerPhone: o.customerPhone, note: o.note,
  totalRwf: o.totalRwf, currency: o.currency, hasProof: !!o.proofPath, proofRequired: o.proofRequired,
  cancelReason: o.cancelReason, createdAt: o.createdAt, updatedAt: o.updatedAt,
  paymentMethod: o.paymentMethod, paidAt: o.paidAt, refundedRwf: o.refundedRwf,
  subtotalRwf: o.subtotalRwf || o.totalRwf, discountRwf: o.discountRwf, promotionName: o.promotionName, customerId: o.customerId,
  ...(o.refunds ? { refunds: o.refunds.map((r) => ({ id: r.id, amountRwf: r.amountRwf, reason: r.reason, method: r.method, by: r.actorName, at: r.createdAt })) } : {}),
  itemCount: o.items ? o.items.reduce((n, i) => n + i.quantity, 0) : undefined,
  ...(items && o.items ? { items: o.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unitPriceRwf: i.unitPriceRwf, note: i.note })) } : {}),
  ...(o.history ? { history: o.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, by: h.actorName, at: h.createdAt })) } : {}),
});

export const emit = (o, type = "order.updated") =>
  publish(o.tenantId, { type, orderId: o.id, number: o.number, status: o.status, paymentStatus: o.paymentStatus });

export async function transition(req, orderId, to, { reason } = {}) {
  const { tenantId, user, can } = req.auth;
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId } });
  if (!order) throw notFound("Order not found.");
  if (!FLOW[order.status].includes(to)) {
    throw conflict(order.status === to ? `This order is already ${to.toLowerCase()}.` : `An order that is ${order.status.toLowerCase()} can't move to ${to.toLowerCase()}.`);
  }
  if (!permissionFor(order.status, to).some((p) => can(p))) throw forbidden();
  if (order.status === "PLACED" && to === "PREPARING" && !paymentOk(order)) {
    throw new AppError(409, order.paymentStatus === "REJECTED" ? "This order's payment proof was rejected. The guest needs to send a new one." : "Confirm the payment proof before the kitchen starts this order.", "PAYMENT_NOT_CONFIRMED");
  }
  const claim = await prisma.order.updateMany({
    where: { id: order.id, tenantId, status: order.status },
    data: { status: to, ...(to === "CANCELLED" ? { cancelReason: reason || null } : {}) },
  });
  if (claim.count === 0) throw conflict("Someone else just updated this order. Refresh to see the latest.");
  await prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: to, actorId: user.id, actorName: user.fullName } });
  const fresh = await prisma.order.findUnique({ where: { id: order.id }, include: { items: true } });
  // Ingredients leave stock when the kitchen starts the order (a cancelled-after-start order stays deducted: the food was made).
  if (order.status === "PLACED" && to === "PREPARING") await deductStockForOrder(fresh, user);
  emit(fresh);
  if (to === "CANCELLED") await audit(req, { action: "order.cancelled", entityType: "order", entityId: order.id, summary: `Cancelled order #${order.number}${reason ? `: ${reason}` : ""}` });
  return fresh;
}

// Receipt data: shared by the staff receipt page and the guest's own receipt link.
export function receiptView(o, tenant, logo) {
  return {
    receiptNo: `R-${o.number}`, orderNumber: o.number, issuedAt: o.paidAt, tableLabel: o.tableLabel, customerName: o.customerName,
    business: { name: tenant.name, phone: tenant.phone, address: tenant.address, city: tenant.city, logoUrl: logo, brandColor: tenant.brandColor },
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceRwf: i.unitPriceRwf, totalRwf: i.quantity * i.unitPriceRwf })),
    subtotalRwf: o.subtotalRwf || o.totalRwf, discountRwf: o.discountRwf, promotionName: o.promotionName,
    totalRwf: o.totalRwf, refundedRwf: o.refundedRwf, netRwf: o.totalRwf - o.refundedRwf, currency: o.currency,
    paymentMethod: o.paymentMethod,
    refunds: (o.refunds || []).map((r) => ({ amountRwf: r.amountRwf, reason: r.reason, at: r.createdAt })),
  };
}
