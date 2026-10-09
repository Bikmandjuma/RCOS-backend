// Runs as part of `npm run db:setup`. Safe to run again: it never changes an existing password.
import "dotenv/config";
import { ensurePlans, listPlans } from "../src/modules/billing/plans.js";
import { DEV_ADMIN, ensurePlatformAdmin } from "../src/modules/platform/bootstrap.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/shared/db.js";

await ensurePlans();
console.table((await listPlans()).map(({ code, name, months, priceRwf }) => ({ code, name, months, priceRwf })));

const email = process.env.ADMIN_EMAIL || (env.isProd ? "" : DEV_ADMIN.email);
const password = process.env.ADMIN_PASSWORD || (env.isProd ? "" : DEV_ADMIN.password);
if (!email || !password) {
  console.log("\nNo platform administrator was created (production needs ADMIN_EMAIL and ADMIN_PASSWORD in .env).\nCreate one with: npm run admin:create -- --email you@example.com --password \"a long passphrase\"");
} else {
  try {
    const r = await ensurePlatformAdmin({ email, password, fullName: process.env.ADMIN_NAME || DEV_ADMIN.fullName });
    console.log(r.created
      ? `\nPlatform administrator created.\n  Sign in at /admin\n  Email:    ${email}\n  Password: ${password === DEV_ADMIN.password ? `${password}   (development placeholder: change it before going live)` : "(the ADMIN_PASSWORD from your .env)"}`
      : `\nPlatform administrator ${email} already exists (password unchanged). To reset it: npm run admin:create`);
  } catch (e) { console.error(`\nCould not create the administrator: ${e.message}`); process.exitCode = 1; }
}
await prisma.$disconnect();
