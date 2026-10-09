import dns from "node:dns/promises";
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/db.js";
import { badRequest } from "../../shared/errors.js";

// DNS is injectable so tests can describe records without a network.
let resolver = { resolveTxt: dns.resolveTxt, resolveCname: dns.resolveCname };
export const setDnsResolver = (r) => { resolver = r; };

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}$/;

export function normalizeDomain(input) {
  const d = String(input || "").trim().toLowerCase();
  if (!d) throw badRequest("Enter your domain, for example order.mycafe.rw");
  if (/[\s/:@?#]/.test(d)) throw badRequest("Enter just the domain name, without https://, a port or a path. For example: order.mycafe.rw");
  if (/^\d+(\.\d+){3}$/.test(d) || !HOSTNAME.test(d)) throw badRequest("That doesn't look like a domain name. Use something like order.mycafe.rw");
  if (env.platformHosts.some((h) => d === h || d.endsWith(`.${h}`))) throw badRequest("That domain belongs to the platform. Use your own domain.");
  return d;
}

export const newDomainToken = () => crypto.randomBytes(16).toString("hex");
export const txtRecord = (domain, token) => ({ type: "TXT", name: `_restaurantos.${domain}`, value: `restaurantos-verify=${token}` });
export const cnameRecord = (domain) => ({ type: "CNAME", name: domain, value: env.cnameTarget });

/** The base URL for a business's public links: its own domain once verified, otherwise the platform's. */
export const publicBase = (tenant) => (tenant.verifiedDomain ? `${env.customDomainScheme}://${tenant.verifiedDomain}` : env.clientUrl);

const MISSING = new Set(["ENODATA", "ENOTFOUND", "ENOENT", "NXDOMAIN"]);
async function safe(fn) {
  try { return await fn(); } catch (e) { if (MISSING.has(e.code)) return []; throw Object.assign(new Error("We couldn't reach the domain name system just now. Please try again in a minute."), { dnsFailure: true }); }
}

/** Looks for the ownership record (required) and a CNAME to the platform (informational). */
export async function checkDns(domain, token) {
  if (env.domainVerifyMode === "skip") return { ownership: true, found: [], pointsHere: null, skipped: true };
  const txt = await safe(() => resolver.resolveTxt(`_restaurantos.${domain}`));
  const found = txt.map((chunks) => (Array.isArray(chunks) ? chunks.join("") : String(chunks)));
  const cname = await safe(() => resolver.resolveCname(domain));
  return { ownership: found.includes(txtRecord(domain, token).value), found, pointsHere: cname.length ? cname.some((c) => c.replace(/\.$/, "").toLowerCase() === env.cnameTarget) : null };
}

// ---- which origins may call the API: the platform's own, plus every verified custom domain ----
const cache = new Map(); // host -> { ok, at }
export const forgetDomainCache = () => cache.clear();
export async function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin tools, curl
  let u; try { u = new URL(origin); } catch { return false; }
  if (origin === env.clientUrl) return true;
  const host = u.hostname.toLowerCase();
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  const t = await prisma.tenant.findUnique({ where: { verifiedDomain: host }, select: { id: true, status: true } });
  const ok = !!t && t.status === "ACTIVE";
  cache.set(host, { ok, at: Date.now() });
  return ok;
}
