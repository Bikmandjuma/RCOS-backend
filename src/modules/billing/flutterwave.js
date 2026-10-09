import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";

// Thin client for Flutterwave Standard (hosted checkout) v3.
// Card + MTN/Airtel Mobile Money Rwanda are offered on the hosted page.
async function flw(path, { method = "GET", body } = {}) {
  if (!env.flw.secretKey) {
    throw new AppError(503, "Online payments aren't configured yet. Set FLW_SECRET_KEY on the server.", "PAYMENTS_NOT_CONFIGURED");
  }
  let res;
  try {
    res = await fetch(`${env.flw.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.flw.secretKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AppError(502, "Couldn't reach the payment provider. Try again in a moment.", "PAYMENTS_UNREACHABLE");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error") {
    throw new AppError(502, json.message || "The payment provider rejected the request.", "PAYMENTS_PROVIDER_ERROR");
  }
  return json;
}

export async function createCheckout({ txRef, amount, currency, redirectUrl, customer, title, description, meta }) {
  const json = await flw("/payments", {
    method: "POST",
    body: {
      tx_ref: txRef,
      amount,
      currency,
      redirect_url: redirectUrl,
      payment_options: "card,mobilemoneyrwanda",
      customer,
      customizations: { title, description },
      meta,
    },
  });
  const link = json?.data?.link;
  if (!link) throw new AppError(502, "The payment provider didn't return a checkout link.", "PAYMENTS_PROVIDER_ERROR");
  return link;
}

export async function verifyTransaction(transactionId) {
  const json = await flw(`/transactions/${encodeURIComponent(transactionId)}/verify`);
  return json.data;
}

export async function verifyByReference(txRef) {
  const json = await flw(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
  return json.data;
}
