import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { asyncHandler } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission } from "../../shared/auth.js";
import { dayRange, todayYmd } from "../../shared/time.js";

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const METHODS = ["MOBILE_MONEY", "CASH", "CARD", "OTHER"];

// End-of-day closing report (PDF §90). Cash basis: money counts on the day payment was confirmed
// or recorded, refunds on the day they were recorded.
reportsRouter.get("/daily", requirePermission("reports.view"), asyncHandler(async (req, res) => {
  const { tenantId, tenant } = req.auth;
  const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-08").optional() }), req.query);
  const date = q.date || todayYmd(tenant.timezone);
  const { start, end } = dayRange(tenant.timezone, date);
  const day = { gte: start, lt: end };

  const [paid, refunds, placed, cancelled, completed, unpaid] = await Promise.all([
    prisma.order.findMany({ where: { tenantId, paymentStatus: "CONFIRMED", paidAt: day }, include: { items: true } }),
    prisma.refund.findMany({ where: { tenantId, createdAt: day } }),
    prisma.order.count({ where: { tenantId, createdAt: day } }),
    prisma.order.count({ where: { tenantId, createdAt: day, status: "CANCELLED" } }),
    prisma.order.count({ where: { tenantId, createdAt: day, status: "COMPLETED" } }),
    prisma.order.findMany({ where: { tenantId, createdAt: day, status: { not: "CANCELLED" }, paymentStatus: { in: ["PROOF_SUBMITTED", "REJECTED", "NOT_REQUIRED"] } }, select: { totalRwf: true } }),
  ]);

  const byMethod = METHODS.map((m) => {
    const rows = paid.filter((o) => (o.paymentMethod || "OTHER") === m);
    return { method: m, count: rows.length, amountRwf: rows.reduce((n, o) => n + o.totalRwf, 0) };
  }).filter((r) => r.count > 0);
  const gross = paid.reduce((n, o) => n + o.totalRwf, 0);
  const refunded = refunds.reduce((n, r) => n + r.amountRwf, 0);

  const items = new Map();
  for (const o of paid) for (const i of o.items) {
    const cur = items.get(i.name) || { name: i.name, quantity: 0, revenueRwf: 0 };
    cur.quantity += i.quantity; cur.revenueRwf += i.quantity * i.unitPriceRwf; items.set(i.name, cur);
  }

  return ok(res, {
    date, timezone: tenant.timezone, currency: tenant.currency,
    orders: { placed, completed, cancelled },
    sales: { grossRwf: gross, orderCount: paid.length, byMethod },
    refunds: { count: refunds.length, amountRwf: refunded, items: refunds.map((r) => ({ at: r.createdAt, amountRwf: r.amountRwf, method: r.method, reason: r.reason, by: r.actorName })) },
    netRwf: gross - refunded,
    notYetPaid: { count: unpaid.length, amountRwf: unpaid.reduce((n, o) => n + o.totalRwf, 0) },
    topItems: [...items.values()].sort((a, b) => b.revenueRwf - a.revenueRwf).slice(0, 10),
  });
}));
