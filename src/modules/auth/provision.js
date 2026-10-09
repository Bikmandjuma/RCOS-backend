import { prisma } from "../../shared/db.js";
import { SYSTEM_ROLES } from "../../shared/permissions.js";
import { slugify, isValidSlug } from "../../shared/slug.js";
import { conflict } from "../../shared/errors.js";
import { env } from "../../config/env.js";
import { normalizeEmail, normalizePhone } from "../../shared/phone.js";
import { DAY_MS } from "../billing/subscription.js";

async function pickSlug(requested, name) {
  if (requested) {
    if (!isValidSlug(requested)) throw conflict("That link name isn't available. Use 3–40 letters, numbers or single hyphens.");
    if (await prisma.tenant.findUnique({ where: { slug: requested } })) throw conflict("That link is already taken. Try another name.");
    return requested;
  }
  const base = slugify(name) || "my-business";
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 36)}-${i + 1}`;
    if (isValidSlug(candidate) && !(await prisma.tenant.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  throw conflict("Couldn't generate a unique link. Please choose one manually.");
}

/**
 * Creates a whole business in one transaction: tenant, main branch, the starter
 * roles, the owner account and a subscription (with a 7-day trial unless this
 * email/phone has already had one).
 */
export async function provisionTenant({ business, owner, passwordHash, planCode }) {
  const slug = await pickSlug(business.slug, business.name);
  const emailKey = `email:${normalizeEmail(owner.email)}`;
  const phoneKey = `phone:${normalizePhone(business.phone)}`;
  const keys = [emailKey, ...(phoneKey.length > 6 ? [phoneKey] : [])];

  return prisma.$transaction(async (tx) => {
    const priorClaim = await tx.trialClaim.findFirst({ where: { key: { in: keys } } });
    const trialGranted = !priorClaim;
    const now = new Date();

    const tenant = await tx.tenant.create({
      data: {
        name: business.name, slug, businessType: business.type, phone: business.phone,
        email: business.email || owner.email, city: business.city || null,
      },
    });
    await tx.branch.create({ data: { tenantId: tenant.id, name: "Main branch", phone: business.phone, address: business.city || null } });

    let ownerRoleId;
    for (const r of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id, name: r.name, description: r.description, isSystem: true, isOwner: !!r.isOwner,
          permissions: { create: r.permissions.map((permission) => ({ permission })) },
        },
      });
      if (r.isOwner) ownerRoleId = role.id;
    }

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id, roleId: ownerRoleId, email: normalizeEmail(owner.email), passwordHash,
        fullName: owner.fullName, phone: business.phone, lastLoginAt: now,
      },
    });

    await tx.subscription.create({
      data: {
        tenantId: tenant.id, planCode,
        trialGranted,
        // No trial for a repeat claimant: access has already "ended" so payment is the first step.
        trialEndsAt: trialGranted ? new Date(now.getTime() + env.trialDays * DAY_MS) : now,
      },
    });

    if (trialGranted) {
      for (const key of keys) await tx.trialClaim.create({ data: { key, tenantId: tenant.id } });
    }

    await tx.auditLog.create({
      data: { tenantId: tenant.id, actorId: user.id, actorName: user.fullName, action: "tenant.created", entityType: "tenant", entityId: tenant.id, summary: `Created the business "${tenant.name}"` },
    });

    return { tenant, user, trialGranted };
  });
}
