import { Router } from "express";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { asyncHandler } from "../../shared/errors.js";
import { authenticate, requirePermission } from "../../shared/auth.js";

export const auditRouter = Router();
auditRouter.use(authenticate);

auditRouter.get("/", requirePermission("audit.view"), asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize) || 20));
  const where = { tenantId: req.auth.tenantId };
  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return ok(res, { items: items.map((l) => ({ id: l.id, action: l.action, summary: l.summary, actorName: l.actorName, entityType: l.entityType, createdAt: l.createdAt })), total, page, pageSize });
}));
