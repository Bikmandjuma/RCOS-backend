import { Router } from "express";
import { z } from "zod";
import { ok } from "../../shared/http.js";
import { asyncHandler, forbidden } from "../../shared/errors.js";
import { parse } from "../../shared/validate.js";
import { authenticate, requirePermission } from "../../shared/auth.js";
import { alerts, forecast, overview } from "./analytics.service.js";
import { QUESTIONS, answer, matchQuestion } from "./ask.js";

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

analyticsRouter.get("/overview", requirePermission("reports.view"), asyncHandler(async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().refine((n) => [7, 30, 90].includes(n), "Choose 7, 30 or 90 days").default(30) }), req.query);
  return ok(res, await overview(req.auth.tenant, days));
}));

analyticsRouter.get("/forecast", requirePermission("reports.view"), asyncHandler(async (req, res) => ok(res, await forecast(req.auth.tenant))));

analyticsRouter.get("/alerts", requirePermission("reports.view"), asyncHandler(async (req, res) => ok(res, await alerts(req.auth.tenant))));

// Only the questions this person is allowed to ask: each needs the same permission as the data behind it.
analyticsRouter.get("/questions", asyncHandler(async (req, res) => ok(res, QUESTIONS.filter((q) => req.auth.can(q.needs)).map(({ id, label }) => ({ id, label })))));

analyticsRouter.post("/ask", asyncHandler(async (req, res) => {
  const b = parse(z.object({ question: z.string({ required_error: "Type a question" }).trim().min(2, "Type a question").max(200) }), req.body);
  const q = matchQuestion(b.question);
  const allowed = QUESTIONS.filter((x) => req.auth.can(x.needs));
  if (!q) return ok(res, { id: null, question: b.question, answer: allowed.length ? "I can answer a fixed set of questions about your own records. Try one of these." : "You don't have access to any reports.", facts: [], suggestions: allowed.map(({ id, label }) => ({ id, label })) });
  if (!req.auth.can(q.needs)) throw forbidden("Your role doesn't include the data needed to answer that.");
  const result = await answer(req.auth.tenant, q);
  return ok(res, { ...result, suggestions: allowed.filter((x) => x.id !== q.id).slice(0, 4).map(({ id, label }) => ({ id, label })) });
}));
