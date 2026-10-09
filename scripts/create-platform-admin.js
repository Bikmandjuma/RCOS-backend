// Creates (or resets the password of) a platform administrator. There is deliberately no public sign-up for this.
// Works the same on Windows, macOS and Linux:
//   npm run admin:create -- --email you@example.com --password "a long passphrase" --name "Your Name" [--role SUPPORT]
// Anything you leave out is read from api/.env (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME).
import "dotenv/config";
import { ensurePlatformAdmin } from "../src/modules/platform/bootstrap.js";
import { prisma } from "../src/shared/db.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--"));
const email = flag("email") || positional[0] || process.env.ADMIN_EMAIL;
const fullName = flag("name") || positional[1] || process.env.ADMIN_NAME || "Platform Admin";
const role = (flag("role") || positional[2] || "SUPER_ADMIN").toUpperCase();
const password = flag("password") || process.env.ADMIN_PASSWORD;

try {
  if (!email || !password) throw new Error('Missing details. Example: npm run admin:create -- --email you@example.com --password "a long passphrase" --name "Your Name"');
  const r = await ensurePlatformAdmin({ email, password, fullName, role, reset: true });
  console.log(`Platform ${r.role} ${r.created ? "created" : "updated (password reset)"}: ${r.email}\nSign in at /admin`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await prisma.$disconnect(); }
