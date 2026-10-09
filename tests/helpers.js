import { execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Isolated database + mock Flutterwave for every test file.
export async function bootstrap(name) {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `file:./test-${name}.db`;
  process.env.JWT_SECRET = "test-secret";
  process.env.CLIENT_URL = "http://localhost:5173";
  process.env.FLW_SECRET_KEY = "FLWSECK_TEST-mock";
  process.env.FLW_SECRET_HASH = "test-webhook-hash";

  const dbFile = path.resolve("prisma", `test-${name}.db`);
  for (const f of [dbFile, `${dbFile}-journal`]) fs.rmSync(f, { force: true });
  execSync("npx prisma db push --skip-generate --force-reset", { stdio: "pipe", env: process.env });

  const mock = await startMockFlutterwave();
  process.env.FLW_BASE_URL = mock.url;

  const { createApp } = await import("../src/app.js");
  const { ensurePlans } = await import("../src/modules/billing/plans.js");
  const { prisma } = await import("../src/shared/db.js");
  await ensurePlans();

  const server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  async function call(method, url, { token, body, headers = {}, form } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, data: json.data };
  }

  let n = 0;
  async function registerBusiness(over = {}) {
    n += 1;
    const body = {
      businessName: `Test Cafe ${n}`, businessType: "COFFEE_SHOP", phone: `078800${String(1000 + n)}`,
      fullName: `Owner ${n}`, email: `owner${n}@example.com`, password: "Passw0rd1", planCode: "monthly", acceptTerms: true, ...over,
    };
    const r = await call("POST", "/auth/register", { body });
    return { ...r, body, res: r.body, token: r.data?.token, user: r.data?.user };
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await mock.close();
    await prisma.$disconnect();
    for (const f of [dbFile, `${dbFile}-journal`]) fs.rmSync(f, { force: true });
  }
  return { call, registerBusiness, prisma, mock, close, base };
}

async function startMockFlutterwave() {
  const state = { payments: [], transactions: {}, failNext: false };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer FLWSECK_TEST-mock") return send(401, { status: "error", message: "Invalid authorization key" });
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/payments") {
        if (state.failNext) { state.failNext = false; return send(400, { status: "error", message: "Invalid currency" }); }
        const body = JSON.parse(raw);
        state.payments.push(body);
        return send(200, { status: "success", data: { link: `https://checkout.flutterwave.test/pay/${body.tx_ref}` } });
      }
      const m = url.pathname.match(/^\/transactions\/([^/]+)\/verify$/);
      if (req.method === "GET" && m) {
        const t = state.transactions[m[1]];
        return t ? send(200, { status: "success", data: t }) : send(404, { status: "error", message: "No transaction was found for this id" });
      }
      if (req.method === "GET" && url.pathname === "/transactions/verify_by_reference") {
        const t = Object.values(state.transactions).find((x) => x.tx_ref === url.searchParams.get("tx_ref"));
        return t ? send(200, { status: "success", data: t }) : send(404, { status: "error", message: "No transaction was found" });
      }
      send(404, { status: "error", message: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}
