import bcrypt from "bcryptjs";
import { prisma } from "../../shared/db.js";
import { env } from "../../config/env.js";

// The placeholder shipped in .env.example so a fresh local install can sign in. It is refused in production.
export const DEV_ADMIN = { email: "admin@restaurantos.local", password: "ChangeMe-Dev-Only-123", fullName: "Platform Admin" };

/**
 * Makes sure a platform administrator exists. By default an existing account is left alone (so re-running setup never
 * silently changes a password); pass reset: true to set a new password for it.
 */
export async function ensurePlatformAdmin({ email, password, fullName = DEV_ADMIN.fullName, role = "SUPER_ADMIN", reset = false, isProd = env.isProd }) {
  const mail = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(mail)) throw new Error("Enter a valid email address for the administrator.");
  if (!["SUPER_ADMIN", "SUPPORT"].includes(role)) throw new Error("Role must be SUPER_ADMIN or SUPPORT.");
  if (String(password || "").length < 12) throw new Error("Use a password of at least 12 characters for a platform administrator.");
  if (isProd && password === DEV_ADMIN.password) throw new Error("Refusing to use the development placeholder password in production. Choose your own.");
  const existing = await prisma.platformUser.findUnique({ where: { email: mail } });
  if (existing && !reset) return { created: false, email: mail, role: existing.role };
  const passwordHash = await bcrypt.hash(password, 12);
  const u = await prisma.platformUser.upsert({
    where: { email: mail },
    update: { passwordHash, fullName, role, isActive: true, tokenVersion: { increment: 1 } },
    create: { email: mail, passwordHash, fullName, role },
  });
  return { created: !existing, reset: !!existing, email: u.email, role: u.role };
}
