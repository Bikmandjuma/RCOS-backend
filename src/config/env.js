import "dotenv/config";

const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var ${name}`);
  return v;
};

const isProd = process.env.NODE_ENV === "production";

if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith("change-me"))) {
  throw new Error("JWT_SECRET must be set to a strong random value in production");
}

const clientUrl = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");
const clientHost = new URL(clientUrl).hostname;
// "skip" trusts a domain without checking DNS. It exists only so automated tests and local demos can run without
// real DNS records, and the server refuses to start with it in production.
const domainVerifyMode = process.env.DOMAIN_VERIFY_MODE === "skip" ? "skip" : "dns";
if (isProd && domainVerifyMode === "skip") throw new Error("DOMAIN_VERIFY_MODE=skip must never be used in production");

export const env = {
  isProd,
  isTest: process.env.NODE_ENV === "test",
  port: Number(process.env.PORT || 4000),
  jwtSecret: required("JWT_SECRET", isProd ? undefined : "dev-only-secret-change-me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  clientUrl,
  // Hosts that belong to the platform itself. A business can't claim these (or anything under them) as its own domain.
  platformHosts: [clientHost, ...(process.env.PLATFORM_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)],
  cnameTarget: (process.env.CNAME_TARGET || `domains.${clientHost}`).toLowerCase(),
  customDomainScheme: process.env.CUSTOM_DOMAIN_SCHEME || (isProd ? "https" : "http"),
  domainVerifyMode,
  apiPublicUrl: (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, ""),
  trialDays: Number(process.env.TRIAL_DAYS || 7),
  // Many devices share one IP in a restaurant (guests + staff on one Wi-Fi), so IP limits must be generous.
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 1500),
  flw: {
    secretKey: process.env.FLW_SECRET_KEY || "",
    secretHash: process.env.FLW_SECRET_HASH || "",
    baseUrl: (process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3").replace(/\/$/, ""),
  },
};
