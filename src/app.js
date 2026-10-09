import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { AppError } from "./shared/errors.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { staffRouter } from "./modules/staff/staff.routes.js";
import { rolesRouter, metaRouter } from "./modules/roles/roles.routes.js";
import { tenantRouter, UPLOAD_ROOT } from "./modules/tenants/tenants.routes.js";
import { billingRouter, webhookRouter } from "./modules/billing/billing.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { publicRouter } from "./modules/public/public.routes.js";
import { menuRouter } from "./modules/menu/menu.routes.js";
import { tablesRouter } from "./modules/tables/tables.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { orderingRouter } from "./modules/public/ordering.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { inventoryRouter } from "./modules/inventory/inventory.routes.js";
import { customersRouter, reviewsRouter } from "./modules/customers/customers.routes.js";
import { marketingRouter } from "./modules/marketing/marketing.routes.js";
import { reservationsRouter } from "./modules/reservations/reservations.routes.js";
import { engageRouter } from "./modules/public/engage.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { platformRouter } from "./modules/platform/platform.routes.js";
import { isAllowedOrigin } from "./modules/tenants/domains.service.js";
import { domainRouter } from "./modules/tenants/domains.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", env.isProd ? 1 : false);
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: (origin, cb) => isAllowedOrigin(origin).then((okk) => cb(null, okk ? origin || true : false), cb), methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["Content-Type", "Authorization"] }));
  app.use(express.json({ limit: "100kb" }));

  if (!env.isTest) {
    app.use(rateLimit({
      windowMs: 60_000, limit: env.rateLimitPerMin, standardHeaders: true, legacyHeaders: false,
      skip: (req) => req.path.endsWith("/orders/stream"), // long-lived live-update streams
      message: { statusCode: 429, message: "Too many requests. Please wait a moment and try again." },
    }));
  }
  const authLimiter = env.isTest ? (_q, _s, n) => n() : rateLimit({
    windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
    message: { statusCode: 429, message: "Too many attempts. Please wait a few minutes and try again." },
  });

  // Public logos only — a strict path pattern keeps every other upload (e.g. future payment proofs) private.
  app.get("/uploads/tenants/:tenantId/logo/:file", (req, res, next) => {
    const { tenantId, file } = req.params;
    if (!/^[a-z0-9]+$/i.test(tenantId) || !/^[a-f0-9]{16}\.(png|jpg|webp)$/.test(file)) return next();
    res.set("Cache-Control", "public, max-age=3600");
    res.sendFile(path.join(UPLOAD_ROOT, "tenants", tenantId, "logo", file), (err) => err && next());
  });

  const v1 = express.Router();
  v1.get("/health", (_req, res) => res.json({ statusCode: 200, message: "OK", data: { ok: true, time: new Date().toISOString() } }));
  v1.use("/public", orderingRouter);
  v1.use("/public", engageRouter);
  v1.use("/public", publicRouter);
  v1.use("/auth/login", authLimiter);
  v1.use("/auth/register", authLimiter);
  v1.use("/auth/invitations", authLimiter);
  v1.use("/admin/login", authLimiter);
  v1.use("/auth", authRouter);
  v1.use("/admin", platformRouter);
  v1.use("/webhooks", webhookRouter);
  v1.use("/meta", metaRouter);
  v1.use("/dashboard", dashboardRouter);
  v1.use("/tenant/domain", domainRouter);
  v1.use("/tenant", tenantRouter);
  v1.use("/staff", staffRouter);
  v1.use("/roles", rolesRouter);
  v1.use("/billing", billingRouter);
  v1.use("/inventory", inventoryRouter);
  v1.use("/customers", customersRouter);
  v1.use("/reviews", reviewsRouter);
  v1.use("/marketing", marketingRouter);
  v1.use("/reservations", reservationsRouter);
  v1.use("/menu", menuRouter);
  v1.use("/tables", tablesRouter);
  v1.use("/orders", ordersRouter);
  v1.use("/reports", reportsRouter);
  v1.use("/analytics", analyticsRouter);
  v1.use("/audit-logs", auditRouter);
  app.use("/api/v1", v1);

  app.use((req, res) => res.status(404).json({ statusCode: 404, message: "Not found." }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ statusCode: err.status, message: err.message, code: err.code, errors: err.details });
    if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ statusCode: 400, message: "That file is too large. The limit is 2 MB." });
    if (err?.name === "MulterError") return res.status(400).json({ statusCode: 400, message: "We couldn't read that upload." });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ statusCode: 400, message: "Malformed request body." });
    if (["P1008", "P2028", "P2034"].includes(err?.code)) return res.status(503).json({ statusCode: 503, message: "The system is busy right now. Please try again in a moment." });
    if (err?.code === "P2002") return res.status(409).json({ statusCode: 409, message: "That already exists." });
    console.error("[error]", err);
    return res.status(500).json({ statusCode: 500, message: "Something went wrong on our side. Please try again." });
  });

  return app;
}
