import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/db.js";
import { ok } from "../../shared/http.js";
import { AppError, asyncHandler, conflict, notFound } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission, requireActiveSubscription } from "../../shared/auth.js";
import { audit } from "../../shared/audit.js";
import { checkDns, cnameRecord, forgetDomainCache, newDomainToken, normalizeDomain, publicBase, txtRecord } from "./domains.service.js";

export const domainRouter = Router();
domainRouter.use(authenticate);

const view = (t, extra = {}) => ({
  domain: t.customDomain, verified: !!t.verifiedDomain && t.verifiedDomain === t.customDomain, publicBase: publicBase(t),
  records: t.customDomain ? { ownership: txtRecord(t.customDomain, t.domainToken), pointer: cnameRecord(t.customDomain) } : null,
  ...extra,
});

domainRouter.get("/", requirePermission("settings.view"), (req, res) => ok(res, view(req.auth.tenant)));

domainRouter.put("/", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const b = parse(z.object({ domain: z.string({ required_error: "Enter your domain" }) }), req.body);
  const domain = normalizeDomain(b.domain);
  const t = req.auth.tenant;
  const same = t.customDomain === domain;
  const u = await prisma.tenant.update({ where: { id: t.id }, data: {
    customDomain: domain, domainToken: same && t.domainToken ? t.domainToken : newDomainToken(),
    ...(same ? {} : { verifiedDomain: null }), // changing the domain means proving the new one
  } });
  forgetDomainCache();
  await audit(req, { action: "domain.claimed", entityType: "tenant", entityId: t.id, summary: `Started connecting the domain ${domain}` });
  return ok(res, view(u), "Domain saved. Add the DNS records below, then check it.");
}));

domainRouter.post("/verify", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const t = req.auth.tenant;
  if (!t.customDomain) throw notFound("Enter your domain first.");
  let dnsResult;
  try { dnsResult = await checkDns(t.customDomain, t.domainToken); } catch (e) { if (e.dnsFailure) throw new AppError(503, e.message, "DNS_UNAVAILABLE"); throw e; }
  if (!dnsResult.ownership) {
    const seen = dnsResult.found.length ? ` We found: ${dnsResult.found.slice(0, 3).join(", ")}.` : " We didn't find any TXT record there yet.";
    throw conflict(`We couldn't confirm you own ${t.customDomain}.${seen} DNS changes can take a few minutes, sometimes longer. Check the record name and value, then try again.`);
  }
  let u;
  try { u = await prisma.tenant.update({ where: { id: t.id }, data: { verifiedDomain: t.customDomain } }); }
  catch (e) { if (e.code === "P2002") throw conflict(`${t.customDomain} is already connected to another business on ${"the platform"}. If it's yours, contact support.`); throw e; }
  forgetDomainCache();
  await audit(req, { action: "domain.verified", entityType: "tenant", entityId: t.id, summary: `Connected the domain ${t.customDomain}` });
  return ok(res, view(u, { pointsHere: dnsResult.pointsHere }), `${t.customDomain} is connected.`);
}));

domainRouter.delete("/", requirePermission("settings.update"), requireActiveSubscription, asyncHandler(async (req, res) => {
  const t = req.auth.tenant;
  if (!t.customDomain) return ok(res, view(t), "No domain to remove.");
  const u = await prisma.tenant.update({ where: { id: t.id }, data: { customDomain: null, domainToken: null, verifiedDomain: null } });
  forgetDomainCache();
  await audit(req, { action: "domain.removed", entityType: "tenant", entityId: t.id, summary: `Removed the domain ${t.customDomain}` });
  return ok(res, view(u), "Domain removed. Your links on the platform address still work.");
}));
