import { Router } from "express";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";
import { ok } from "../../shared/http.js";
import { asyncHandler, notFound } from "../../shared/errors.js";
import { isValidSlug, RESERVED_SLUGS, SLUG_RE } from "../../shared/slug.js";
import { listPlans } from "../billing/plans.js";
import { withSavings } from "../billing/subscription.js";
import { logoUrl } from "../auth/views.js";

export const publicRouter = Router();

publicRouter.get("/plans", asyncHandler(async (_req, res) => {
  return ok(res, { trialDays: env.trialDays, currency: "RWF", plans: withSavings(await listPlans()) });
}));

publicRouter.get("/slug-check", asyncHandler(async (req, res) => {
  const slug = String(req.query.slug || "").trim().toLowerCase();
  if (!slug) return ok(res, { slug, available: false, reason: "Enter a link name." });
  if (!SLUG_RE.test(slug) || slug.includes("--")) return ok(res, { slug, available: false, reason: "Use 3–40 letters, numbers or single hyphens." });
  if (RESERVED_SLUGS.has(slug)) return ok(res, { slug, available: false, reason: "That name is reserved." });
  const taken = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  return ok(res, { slug, available: !taken, reason: taken ? "That link is already taken." : null });
}));

// Is the branch open right now, in the business's own timezone?
function openState(branch, timezone) {
  if (!branch) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const now = Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const o = toMin(branch.opensAt), c = toMin(branch.closesAt);
  const open = o <= c ? now >= o && now < c : now >= o || now < c; // supports closing after midnight
  return { open, opensAt: branch.opensAt, closesAt: branch.closesAt };
}

// Public storefront data for /r/:slug. Deliberately limited: no staff, no billing, no ids.
publicRouter.get("/restaurants/:slug", asyncHandler(async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!isValidSlug(slug)) throw notFound("We couldn't find this restaurant.");
  const t = await prisma.tenant.findUnique({ where: { slug }, include: { branches: { orderBy: { createdAt: "asc" } } } });
  if (!t || t.status !== "ACTIVE") throw notFound("We couldn't find this restaurant.");
  const main = t.branches.find((b) => b.isMain) || t.branches[0];
  const [agg, recent] = await Promise.all([
    prisma.review.aggregate({ where: { tenantId: t.id, hidden: false }, _avg: { rating: true }, _count: true }),
    prisma.review.findMany({ where: { tenantId: t.id, hidden: false }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);
  return ok(res, {
    rating: agg._count ? { average: Math.round(agg._avg.rating * 10) / 10, count: agg._count } : null,
    reviews: recent.map((r) => ({ rating: r.rating, comment: r.comment, author: r.authorName, at: r.createdAt })),
    reservations: { accepting: t.acceptReservations, maxPartySize: t.maxPartySize },
    name: t.name, slug: t.slug, businessType: t.businessType, description: t.description, brandColor: t.brandColor,
    logoUrl: logoUrl(t), city: t.city, address: main?.address || t.address, phone: main?.phone || t.phone,
    hours: openState(main, t.timezone),
  });
}));

// The web app calls this when it is opened on an address it doesn't recognise: is that a business's own domain?
publicRouter.get("/domain/resolve", asyncHandler(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*"); // read-only and only ever reveals a public page's name and link, so any origin may ask
  const host = String(req.query.host || "").trim().toLowerCase();
  const t = host ? await prisma.tenant.findUnique({ where: { verifiedDomain: host } }) : null;
  if (!t || t.status !== "ACTIVE") throw notFound("No business uses this address.");
  return ok(res, { slug: t.slug, name: t.name, platformUrl: env.clientUrl });
}));

// For a TLS front end (e.g. Caddy's on-demand certificates): only ask Let's Encrypt for domains we actually serve.
publicRouter.get("/domain/check", asyncHandler(async (req, res) => {
  const d = String(req.query.domain || "").trim().toLowerCase();
  const platform = env.platformHosts.includes(d);
  const t = !platform && d ? await prisma.tenant.findUnique({ where: { verifiedDomain: d }, select: { status: true } }) : null;
  if (platform || (t && t.status === "ACTIVE")) return res.status(200).type("text/plain").send("ok");
  return res.status(404).type("text/plain").send("unknown domain");
}));
