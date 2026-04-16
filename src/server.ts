/**
 * x402-enabled API server — explicit payment flow (no middleware)
 *
 * Every step of the payment flow is handled directly in the route handler:
 *   1. No signature header → build PaymentRequired, return 402
 *   2. Signature present → decode payload
 *   3. Call facilitator /verify
 *   4. Call facilitator /settle
 *   5. Return 200 with response
 *
 * FACILITATOR_URL env var switches between facilitators:
 *   default              → https://x402.org/facilitator (Coinbase testnet)
 *   http://localhost:4022 → our custom facilitator
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import {
  HTTPFacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { config, BASE_SEPOLIA, USDC_ADDRESS } from "./config.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? config.coinbaseFacilitatorUrl;
const PORT = config.apiServerPort;

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// The exact shape the agent's SDK expects to see in the PAYMENT-REQUIRED header.
// amount is in USDC atomic units (6 decimals): 100 = $0.0001
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: BASE_SEPOLIA,
  asset: USDC_ADDRESS,
  amount: "100",
  payTo: config.payToAddress,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

console.log(`[server] Starting`);
console.log(`[server] Pay-to     : ${config.payToAddress}`);
console.log(`[server] Facilitator: ${FACILITATOR_URL}`);
console.log(`[server] Price      : $0.0001 USDC (100 atomic units)`);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", facilitator: FACILITATOR_URL, payTo: config.payToAddress });
});

// Note: this payment flow can be abstracted into middleware — see paymentMiddlewareFromConfig
// from @x402/express. It is written explicitly here for educational purposes.
app.get("/data", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const t0 = Date.now();

  console.log(`\n[server] [${requestId}] incoming GET /data`);

  // ── Step 1: no payment header → return 402 ──────────────────────────────────
  // v2 uses "PAYMENT-SIGNATURE", v1 uses "X-PAYMENT" — Express lowercases all header names
  const sigHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

  if (!sigHeader) {
    console.log(`[server] [${requestId}] no payment header → 402`);

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://localhost:${PORT}/data`,
        description: "Premium data endpoint (x402 prototype)",
        mimeType: "application/json",
      },
      accepts: [requirements],
    };

    res
      .status(402)
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
      .json({});
    return;
  }

  // ── Step 2: decode the signed payment payload ────────────────────────────────
  let paymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(sigHeader);
    const payer = (paymentPayload as { payload?: { authorization?: { from?: string } } })
      ?.payload?.authorization?.from ?? "unknown";
    console.log(`[server] [${requestId}] payment header decoded — payer: ${payer}`);
  } catch (err) {
    console.error(`[server] [${requestId}] failed to decode payment header:`, err);
    res.status(400).json({ error: "Invalid X-Payment-Signature header" });
    return;
  }

  // ── Step 3: verify ───────────────────────────────────────────────────────────
  console.log(`[server] [${requestId}] → POST ${FACILITATOR_URL}/verify`);
  const t1 = Date.now();

  let verified;
  try {
    verified = await facilitator.verify(paymentPayload, requirements);
  } catch (err) {
    console.error(`[server] [${requestId}] facilitator verify threw:`, err);
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  console.log(`[server] [${requestId}] ← verify ${Date.now() - t1}ms isValid=${verified.isValid}${verified.isValid ? "" : ` reason=${verified.invalidReason}`}`);

  if (!verified.isValid) {
    res
      .status(402)
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({
        x402Version: 2,
        error: verified.invalidReason ?? "Payment invalid",
        resource: { url: `http://localhost:${PORT}/data` },
        accepts: [requirements],
      }))
      .json({});
    return;
  }

  // ── Step 4: settle ───────────────────────────────────────────────────────────
  console.log(`[server] [${requestId}] → POST ${FACILITATOR_URL}/settle`);
  const t2 = Date.now();

  let settled;
  try {
    settled = await facilitator.settle(paymentPayload, requirements);
  } catch (err) {
    console.error(`[server] [${requestId}] facilitator settle threw:`, err);
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  console.log(`[server] [${requestId}] ← settle ${Date.now() - t2}ms success=${settled.success}${settled.success ? ` tx=${settled.transaction}` : ` reason=${settled.errorReason}`}`);

  if (!settled.success) {
    res.status(402).json({ error: "Settlement failed", reason: settled.errorReason });
    return;
  }

  // ── Step 5: return response ──────────────────────────────────────────────────
  const total = Date.now() - t0;
  console.log(`[server] [${requestId}] ✓ done — total ${total}ms (verify ${t1 ? Date.now() - t1 : "?"}ms + settle ${Date.now() - t2}ms)`);

  res
    .set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled))
    .json({
      message: "You paid for this!",
      requestId,
      timing: {
        totalMs: total,
        verifyMs: t2 - t1,
        settleMs: Date.now() - t2,
      },
      payment: {
        tx: settled.transaction,
        payer: verified.payer,
        network: settled.network,
        amount: "$0.0001 USDC",
      },
    });
});

app.listen(PORT, () => {
  console.log(`\n[server] Ready — http://localhost:${PORT}`);
  console.log(`[server] Paid endpoint: GET http://localhost:${PORT}/data`);
});
