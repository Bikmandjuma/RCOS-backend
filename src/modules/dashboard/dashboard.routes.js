import { Router } from "express";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { ok } from "../../shared/http.js";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate } from "../../shared/auth.js";
import { publicBase } from "../tenants/domains.service.js";
import { statusOf } from "../inventory/stock.service.js";
import { getSubscriptionView } from "../billing/billing.service.js";

export const dashboardRouter = Router();

// Midnight "today" in the business's own timezone, as a UTC instant.
function startOfToday(tz) {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offset = Math.round((local.getTime() - now.getTime()) / 60000) * 60000;
  const midnight = new Date(local); midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - offset);
}
dashboardRouter.use(authenticate);

dashboardRouter.get("/summary", asyncHandler(async (req, res) => {
  const { tenantId, tenant, can } = req.auth;
  const [subscription, activeStaff, pendingInvites, roleCount, branch] = await Promise.all([
    getSubscriptionView(tenantId),
    can("staff.view") ? prisma.user.count({ where: { tenantId, isActive: true } }) : null,
    can("staff.view") ? prisma.staffInvitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }) : null,
    can("roles.view") ? prisma.role.count({ where: { tenantId } }) : null,
    prisma.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
  ]);

  // Real, derived progress — nothing here is hard-coded as "done".
  const [staffCount, invites, productCount, tableCount, orderCount] = await Promise.all([
    prisma.user.count({ where: { tenantId } }),
    prisma.staffInvitation.count({ where: { tenantId } }),
    prisma.product.count({ where: { tenantId } }),
    prisma.diningTable.count({ where: { tenantId } }),
    prisma.order.count({ where: { tenantId } }),
  ]);

  let today = null;
  if (can("orders.view")) {
    const since = startOfToday(tenant.timezone);
    const todays = { tenantId, createdAt: { gte: since }, status: { not: "CANCELLED" } };
    const [orders, revenue, review, inKitchen] = await Promise.all([
      prisma.order.count({ where: todays }),
      prisma.order.aggregate({ where: { ...todays, paymentStatus: "CONFIRMED" }, _sum: { totalRwf: true } }),
      prisma.order.count({ where: { tenantId, paymentStatus: "PROOF_SUBMITTED", status: { not: "CANCELLED" } } }),
      prisma.order.count({ where: { tenantId, status: { in: ["PLACED", "PREPARING", "READY"] }, paymentStatus: { in: ["CONFIRMED", "NOT_REQUIRED"] } } }),
    ]);
    today = { orders, confirmedRevenueRwf: revenue._sum.totalRwf || 0, awaitingPaymentCheck: review, inKitchen };
  }
  const checklist = [
    { key: "business", label: "Create your business", done: true },
    { key: "details", label: "Add a description and address", done: !!(tenant.description && (branch?.address || tenant.address)), href: "/app/business", requires: "settings.update" },
    { key: "logo", label: "Upload your logo", done: !!tenant.logoPath, href: "/app/business", requires: "settings.update" },
    { key: "menu", label: "Add your menu", done: productCount > 0, href: "/app/menu", requires: "products.create" },
    { key: "tables", label: "Add your tables and print QR codes", done: tableCount > 0, href: "/app/tables", requires: "tables.create" },
    { key: "payment", label: "Tell guests how to pay you", done: !!tenant.paymentInstructions, href: "/app/business", requires: "settings.update" },
    { key: "team", label: "Invite your first team member", done: staffCount > 1 || invites > 0, href: "/app/staff", requires: "staff.create" },
    { key: "order", label: "Take your first order", done: orderCount > 0 },
  ].map((i) => ({ ...i, actionable: !i.requires || can(i.requires) }));

  let lowStock = null;
  if (can("inventory.view")) {
    const ings = await prisma.ingredient.findMany({ where: { tenantId } });
    const flagged = ings.map((i) => ({ i, s: statusOf(i) })).filter((x) => x.s !== "OK").sort((a, b) => (a.s === "OUT" ? 0 : 1) - (b.s === "OUT" ? 0 : 1));
    lowStock = { count: flagged.length, items: flagged.slice(0, 5).map(({ i, s }) => ({ id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, status: s })) };
  }
  let reservations = null;
  if (can("reservations.view")) {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timezone }).format(new Date());
    const [pending, todayCount] = await Promise.all([
      prisma.reservation.count({ where: { tenantId, status: "PENDING", date: { gte: ymd } } }),
      prisma.reservation.count({ where: { tenantId, date: ymd, status: { in: ["PENDING", "CONFIRMED", "ARRIVED", "SEATED"] } } }),
    ]);
    reservations = { pending, today: todayCount };
  }
  const upcoming = ["Sales analytics and forecasting", "AI business assistant", "Delivery and integrations"];

  return ok(res, {
    subscription,
    today,
    lowStock,
    reservations,
    team: activeStaff === null ? null : { activeStaff, pendingInvites },
    roles: roleCount === null ? null : { count: roleCount },
    checklist,
    upcoming,
    publicUrl: tenant.verifiedDomain ? publicBase(tenant) : `${env.clientUrl}/r/${tenant.slug}`,
  });
}));
