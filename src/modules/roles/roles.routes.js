import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { ok, created } from "../../shared/http.js";
import { asyncHandler, badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { PERMISSION_CATALOG, isValidPermission, ALL_PERMISSIONS } from "../../shared/permissions.js";
import { audit } from "../../shared/audit.js";

export const rolesRouter = Router();
export const metaRouter = Router();

metaRouter.get("/permissions", authenticate, (_req, res) => ok(res, PERMISSION_CATALOG));

rolesRouter.use(authenticate);

const roleView = (r, extra = {}) => ({
  id: r.id, name: r.name, description: r.description, isSystem: r.isSystem, isOwner: r.isOwner,
  userCount: r._count?.users ?? 0,
  permissions: r.isOwner ? ALL_PERMISSIONS : (r.permissions || []).map((p) => p.permission).sort(),
  ...extra,
});

const body = z.object({
  name: z.string().trim().min(2, "Enter a role name").max(40),
  description: z.string().trim().max(200).optional().or(z.literal("")),
  permissions: z.array(z.string()).max(200),
});

function cleanPermissions(list) {
  const unique = [...new Set(list)];
  const bad = unique.find((p) => !isValidPermission(p));
  if (bad) throw badRequest(`Unknown permission "${bad}".`);
  return unique;
}

// Privilege-escalation guard: you can only grant permissions you hold yourself.
function assertCanGrant(req, perms) {
  if (req.auth.role.isOwner) return;
  const over = perms.find((p) => !req.auth.permissions.has(p));
  if (over) throw forbidden(`You can't grant "${over}" because your own role doesn't include it.`);
}

rolesRouter.get("/", requirePermission("roles.view"), asyncHandler(async (req, res) => {
  const roles = await prisma.role.findMany({
    where: { tenantId: req.auth.tenantId }, include: { permissions: true, _count: { select: { users: true } } }, orderBy: { createdAt: "asc" },
  });
  return ok(res, roles.map((r) => roleView(r)));
}));

rolesRouter.get("/:id", requirePermission("roles.view"), asyncHandler(async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: req.auth.tenantId }, include: { permissions: true, _count: { select: { users: true } } } });
  if (!role) throw notFound("Role not found.");
  return ok(res, roleView(role));
}));

rolesRouter.post("/", requirePermission("roles.create"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(body, req.body);
  const perms = cleanPermissions(b.permissions);
  assertCanGrant(req, perms);
  const { tenantId } = req.auth;
  if (await prisma.role.findFirst({ where: { tenantId, name: { equals: b.name } } })) throw conflict("A role with this name already exists.");
  const role = await prisma.role.create({
    data: { tenantId, name: b.name, description: b.description || null, permissions: { create: perms.map((permission) => ({ permission })) } },
    include: { permissions: true, _count: { select: { users: true } } },
  });
  await audit(req, { action: "role.created", entityType: "role", entityId: role.id, summary: `Created the role "${role.name}" with ${perms.length} permissions` });
  return created(res, roleView(role), "Role created.");
}));

rolesRouter.patch("/:id", requirePermission("roles.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId }, include: { permissions: true } });
  if (!role) throw notFound("Role not found.");
  if (role.isOwner) throw forbidden("The Owner role always has full access and can't be edited.");

  const b = parse(body.partial(), req.body);
  const perms = b.permissions ? cleanPermissions(b.permissions) : null;
  if (perms) assertCanGrant(req, perms);
  if (b.name && role.isSystem && b.name !== role.name) throw badRequest("Starter roles keep their names. Create a custom role instead.");
  if (b.name && b.name !== role.name && (await prisma.role.findFirst({ where: { tenantId, name: b.name } }))) throw conflict("A role with this name already exists.");
  // Stop someone editing their own role to reach beyond what they were given.
  if (perms && role.id === req.auth.role.id && !req.auth.role.isOwner) throw forbidden("You can't change the permissions of your own role.");

  const before = new Set(role.permissions.map((p) => p.permission));
  await prisma.$transaction(async (tx) => {
    await tx.role.update({ where: { id: role.id }, data: { ...(b.name ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description || null } : {}) } });
    if (perms) {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({ data: perms.map((permission) => ({ roleId: role.id, permission })) });
    }
  });
  const fresh = await prisma.role.findFirst({ where: { id: role.id, tenantId }, include: { permissions: true, _count: { select: { users: true } } } });
  const added = perms ? perms.filter((p) => !before.has(p)).length : 0;
  const removed = perms ? [...before].filter((p) => !perms.includes(p)).length : 0;
  await audit(req, { action: "role.updated", entityType: "role", entityId: role.id, summary: `Updated the role "${fresh.name}"${perms ? ` (+${added} / −${removed} permissions)` : ""}` });
  return ok(res, roleView(fresh), "Role saved.");
}));

rolesRouter.delete("/:id", requirePermission("roles.delete"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const { tenantId } = req.auth;
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId }, include: { _count: { select: { users: true } } } });
  if (!role) throw notFound("Role not found.");
  if (role.isSystem) throw forbidden("Starter roles can't be deleted.");
  if (role._count.users > 0) throw conflict(`${role._count.users} team member(s) still have this role. Move them to another role first.`);
  const pending = await prisma.staffInvitation.count({ where: { roleId: role.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (pending > 0) throw conflict("There are pending invitations for this role. Revoke them first.");
  await prisma.$transaction([
    prisma.staffInvitation.deleteMany({ where: { roleId: role.id, tenantId } }),
    prisma.role.delete({ where: { id: role.id } }),
  ]);
  await audit(req, { action: "role.deleted", entityType: "role", entityId: role.id, summary: `Deleted the role "${role.name}"` });
  return ok(res, null, "Role deleted.");
}));
