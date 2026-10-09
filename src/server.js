import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensurePlans } from "./modules/billing/plans.js";

await ensurePlans();
createApp().listen(env.port, () => {
  console.log(`RestaurantOS API listening on :${env.port} (${env.isProd ? "production" : "development"})`);
  if (!env.flw.secretKey) console.warn("[billing] FLW_SECRET_KEY is not set — checkout is disabled until you add it.");
});
