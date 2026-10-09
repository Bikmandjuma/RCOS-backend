import { prisma } from "./db.js";
import { verifyAccessToken } from "./tokens.js";
import { unauthorized, forbidden, paymentRequired, asyncHandler } from "./errors.js";
import { ALL_PERMISSIONS } from "./permissions.js";
import { hasAccess } from "../modules/billing/subscription.js";

/**
 * Authenticate + establish tenant context.
 * The tenant ALWAYS comes from the authenticated user's own record — never from the
 * request body, query or headers (PDF §62). Handlers must scope every query with req.auth.tenantId.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw unauthorized("Your session has expired. Please sign in again.");
  }

  if (payload.aud === "platform") throw unauthorized(); // operator tokens never work on restaurant routes
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { role: { include: { permissions: true } }, tenant: { include: { subscription: true } } },
  });
  if (!user || user.tokenVersion !== payload.tv) throw unauthorized("Your session has expired. Please sign in again.");
  if (!user.isActive) throw unauthorized("This account has been deactivated. Contact your business owner.");
  if (user.tenant.status !== "ACTIVE") throw forbidden("This business account is suspended.");

  const permissions = user.role.isOwner ? new Set(ALL_PERMISSIONS) : new Set(user.role.permissions.map((p) => p.permission));
  req.auth = {
    user,
    tenantId: user.tenantId,
    tenant: user.tenant,
    subscription: user.tenant.subscription,
    role: user.role,
    permissions,
    can: (p) => permissions.has(p),
  };
  next();
});

export const requirePermission = (...needed) => (req, _res, next) => {
  const ok = needed.every((p) => req.auth.permissions.has(p));
  if (!ok) return next(forbidden());
  next();
};

/** Blocks writes once the trial / paid period has ended (billing + read-only stay available). */
export const requireActiveSubscription = (req, _res, next) => {
  const sub = req.auth.subscription;
  if (!sub || !hasAccess(sub)) {
    return next(paymentRequired("Your free trial or subscription has ended. Choose a plan to keep managing your business."));
  }
  next();
};
