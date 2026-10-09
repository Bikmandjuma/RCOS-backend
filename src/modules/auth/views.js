import { env } from "../../config/env.js";
import { ALL_PERMISSIONS } from "../../shared/permissions.js";
import { buildSubscriptionView } from "../billing/subscription.js";
import { listPlans } from "../billing/plans.js";

export const logoUrl = (tenant) =>
  tenant.logoPath ? `${env.apiPublicUrl}/uploads/${tenant.logoPath}` : null;

export const tenantView = (t) => ({
  id: t.id, name: t.name, slug: t.slug, businessType: t.businessType, description: t.description,
  phone: t.phone, email: t.email, address: t.address, city: t.city, country: t.country,
  currency: t.currency, timezone: t.timezone, brandColor: t.brandColor, logoUrl: logoUrl(t), paymentInstructions: t.paymentInstructions, requirePaymentProof: t.requirePaymentProof, acceptReservations: t.acceptReservations, maxPartySize: t.maxPartySize,
});

export async function sessionView(user) {
  // `user` must include role.permissions, tenant and tenant.subscription
  const plans = await listPlans();
  const permissions = user.role.isOwner ? ALL_PERMISSIONS : user.role.permissions.map((p) => p.permission);
  return {
    id: user.id, fullName: user.fullName, email: user.email, phone: user.phone,
    role: { id: user.role.id, name: user.role.name, isOwner: user.role.isOwner },
    permissions,
    tenant: tenantView(user.tenant),
    subscription: user.tenant.subscription ? buildSubscriptionView(user.tenant.subscription, plans) : null,
  };
}
