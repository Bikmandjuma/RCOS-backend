import { prisma } from "./db.js";

// Sensitive actions are traceable (PDF §36): who, what, when, from where.
export async function audit(req, { action, entityType, entityId, summary, meta, tenantId, actor }) {
  const a = actor || req?.auth?.user;
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: tenantId || req.auth.tenantId,
        actorId: a?.id ?? null,
        actorName: a?.fullName ?? null,
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        summary,
        meta: meta ? JSON.stringify(meta) : null,
        ip: req?.ip ?? null,
      },
    });
  } catch (e) {
    // Audit failures must never break the user's action, but should be visible in logs.
    console.error("[audit] failed to write log:", e.message);
  }
}
