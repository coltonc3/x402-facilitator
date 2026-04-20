/**
 * Payment-gated API server — accepts x402 or MPP on every endpoint.
 *
 * Protocol selection is automatic — whichever payment header arrives first wins:
 *   x402  →  PAYMENT-SIGNATURE header  (client signs auth; server settles on-chain)
 *   MPP   →  Authorization: Payment    (client settles on-chain; server verifies tx)
 *
 * On a 402 challenge, both WWW-Authenticate (MPP) and PAYMENT-REQUIRED (x402) headers
 * are returned so any compliant client can proceed.
 *
 * To add a new payment protocol:
 *   1. Detect its header in detectPaymentHeader()
 *   2. Add its challenge to the 402 response block
 *   3. Add a verification branch before the final response
 *
 * FACILITATOR_URL env var switches between x402 facilitators:
 *   default                          → http://localhost:4022 (custom facilitator)
 *   https://x402.org/facilitator     → Coinbase testnet facilitator
 */

import "dotenv/config";
import { randomBytes, randomUUID } from "crypto";
import express from "express";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  HTTPFacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { config, BASE_SEPOLIA, USDC_ADDRESS, USDT_ADDRESS, FACILITATOR_ADDRESS } from "./config.js";
import { createChallengeId, verifyChallengeId } from "./mpp/challenge.js";
import { buildWwwAuthenticate, parseMppCredential, buildPaymentReceipt } from "./mpp/headers.js";
import { verifyTempoCharge } from "./mpp/tempo.js";
import type { MppChallengeParams } from "./mpp/types.js";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? `http://localhost:${config.facilitatorPort}`;
const PORT = config.apiServerPort;

// Signs MPP challenge IDs — must be kept secret. Uses an ephemeral key if not set
// (challenges won't survive restart, but this is fine for single-process deployments).
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY ?? (() => {
  const k = randomBytes(32).toString("hex");
  console.warn("[server] MPP_SECRET_KEY not set — using ephemeral key (set it for stable challenges)");
  return k;
})();

// ─── x402 facilitator client ─────────────────────────────────────────────────
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// ─── Shared public client for MPP on-chain verification ──────────────────────
// Read-only — no wallet or gas needed on this side.
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

// Replay protection: each MPP challenge jti may be used exactly once.
const usedMppChallenges = new Set<string>();

// ─── x402 payment requirements ───────────────────────────────────────────────

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: BASE_SEPOLIA,
  asset: USDC_ADDRESS,
  amount: "100",
  payTo: config.payToAddress,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const allowanceRequirements: PaymentRequirements = {
  scheme: "allowance",
  network: BASE_SEPOLIA,
  asset: USDT_ADDRESS,
  amount: "100",
  payTo: config.payToAddress,
  maxTimeoutSeconds: 300,
  extra: { facilitatorAddress: FACILITATOR_ADDRESS },
};

// ─── MPP challenge params ─────────────────────────────────────────────────────

const mppUsdc: MppChallengeParams = {
  method: "tempo",
  intent: "charge",
  amount: "100",
  currency: USDC_ADDRESS,
  payTo: config.payToAddress,
  description: "Premium data endpoint",
  realm: "x402-facilitator",
};

const mppUsdt: MppChallengeParams = {
  method: "tempo",
  intent: "charge",
  amount: "100",
  currency: USDT_ADDRESS,
  payTo: config.payToAddress,
  description: "Premium data endpoint (USDT)",
  realm: "x402-facilitator",
};

// ─── Header detection ─────────────────────────────────────────────────────────

function detectPaymentHeader(req: express.Request): { x402?: string; mpp?: string } {
  const x402 = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
  const auth  = req.headers["authorization"] as string | undefined;
  return { x402, mpp: auth?.startsWith("Payment ") ? auth : undefined };
}

// ─── MPP path helper ──────────────────────────────────────────────────────────

async function handleMppTempo(
  res: express.Response,
  requestId: string,
  mppHeader: string,
  params: MppChallengeParams,
  t0: number,
): Promise<boolean> {
  const credential = parseMppCredential(mppHeader);
  if (!credential) {
    res.status(400).json({ error: "malformed Authorization: Payment header" });
    return false;
  }
  console.log(`[server] [${requestId}] MPP credential id=${credential.id.slice(0, 20)}...`);

  if (credential.method !== "tempo") {
    res.status(400).json({ error: `unsupported MPP method: ${credential.method}` });
    return false;
  }

  const challengeCheck = verifyChallengeId(
    credential.id,
    { method: params.method, amount: params.amount, currency: params.currency, payTo: params.payTo },
    MPP_SECRET_KEY,
  );
  if (!challengeCheck.valid) {
    console.log(`[server] [${requestId}] MPP challenge invalid: ${challengeCheck.reason}`);
    res.status(402)
      .set("WWW-Authenticate", `Payment error="${challengeCheck.reason}"`)
      .json({ error: challengeCheck.reason });
    return false;
  }

  if (usedMppChallenges.has(challengeCheck.jti)) {
    console.log(`[server] [${requestId}] MPP challenge already used: ${challengeCheck.jti}`);
    res.status(402).json({ error: "challenge already used" });
    return false;
  }

  const tempoPayload = credential.payload as { intent?: string; transaction?: string };
  if (tempoPayload.intent !== "charge" || typeof tempoPayload.transaction !== "string") {
    res.status(400).json({ error: "MPP payload must have intent=charge and a transaction hash" });
    return false;
  }

  console.log(`[server] [${requestId}] MPP verifying tx ${tempoPayload.transaction.slice(0, 18)}...`);
  const t1 = Date.now();

  const mppResult = await verifyTempoCharge(
    publicClient,
    tempoPayload.transaction as `0x${string}`,
    {
      payTo:    params.payTo    as `0x${string}`,
      currency: params.currency as `0x${string}`,
      amount:   params.amount,
    },
  );

  console.log(`[server] [${requestId}] ← MPP verify ${Date.now() - t1}ms isValid=${mppResult.isValid}${mppResult.isValid ? "" : ` reason=${mppResult.invalidReason}`}`);

  if (!mppResult.isValid) {
    res.status(402).json({ error: mppResult.invalidReason });
    return false;
  }

  usedMppChallenges.add(challengeCheck.jti);

  const total = Date.now() - t0;
  console.log(`[server] [${requestId}] ✓ done (MPP/tempo) — total ${total}ms`);

  res
    .set("Payment-Receipt", buildPaymentReceipt(credential.id, "tempo"))
    .json({
      message: "You paid for this!",
      requestId,
      timing: { totalMs: total, verifyMs: Date.now() - t1 },
      payment: {
        tx:       tempoPayload.transaction,
        payer:    mppResult.payer,
        network:  BASE_SEPOLIA,
        amount:   `$0.0001 ${params.method === "tempo" ? params.currency === USDC_ADDRESS ? "USDC" : "USDT" : "token"}`,
        protocol: "mpp/tempo",
      },
    });
  return true;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

console.log(`[server] Starting`);
console.log(`[server] Pay-to     : ${config.payToAddress}`);
console.log(`[server] Facilitator: ${FACILITATOR_URL}`);
console.log(`[server] Price      : $0.0001 USDC (100 atomic units)`);
console.log(`[server] Protocols  : x402, MPP (tempo/Base Sepolia)`);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    facilitator: FACILITATOR_URL,
    payTo: config.payToAddress,
    protocols: ["x402", "mpp"],
  });
});

// ─── GET /data — USDC, exact scheme (x402) / tempo (MPP) ─────────────────────
//
// Note: this payment flow can be abstracted into middleware — see paymentMiddlewareFromConfig
// from @x402/express. It is written explicitly here for educational purposes.
app.get("/data", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const t0 = Date.now();

  console.log(`\n[server] [${requestId}] incoming GET /data`);

  const { x402: sigHeader, mpp: mppHeader } = detectPaymentHeader(req);

  // ── No payment header → 402 with both challenges ──────────────────────────
  if (!sigHeader && !mppHeader) {
    console.log(`[server] [${requestId}] no payment header → 402 (x402 + MPP)`);

    const mppChallengeId = createChallengeId(
      mppUsdc.method, mppUsdc.amount, mppUsdc.currency, mppUsdc.payTo, MPP_SECRET_KEY,
    );

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://localhost:${PORT}/data`,
        description: "Premium data endpoint",
        mimeType: "application/json",
      },
      accepts: [requirements],
    };

    res
      .status(402)
      .set("Cache-Control", "no-store")
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
      .set("WWW-Authenticate", buildWwwAuthenticate({ ...mppUsdc, id: mppChallengeId }))
      .json({});
    return;
  }

  // ── x402 path ──────────────────────────────────────────────────────────────
  if (sigHeader) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(sigHeader);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payer = (paymentPayload as any)?.payload?.authorization?.from ?? (paymentPayload as any)?.payload?.owner ?? "unknown";
      console.log(`[server] [${requestId}] x402 decoded — payer: ${payer}`);
    } catch (err) {
      console.error(`[server] [${requestId}] failed to decode x402 header:`, err);
      res.status(400).json({ error: "Invalid PAYMENT-SIGNATURE header" });
      return;
    }

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

    const total = Date.now() - t0;
    console.log(`[server] [${requestId}] ✓ done (x402) — total ${total}ms`);

    res
      .set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled))
      .json({
        message: "You paid for this!",
        requestId,
        timing: { totalMs: total, verifyMs: t2 - t1, settleMs: Date.now() - t2 },
        payment: {
          tx:       settled.transaction,
          payer:    verified.payer,
          network:  settled.network,
          amount:   "$0.0001 USDC",
          protocol: "x402",
        },
      });
    return;
  }

  // ── MPP path ───────────────────────────────────────────────────────────────
  await handleMppTempo(res, requestId, mppHeader!, mppUsdc, t0);
});

// ─── GET /data-usdt — USDT, allowance scheme (x402) / tempo (MPP) ────────────
app.get("/data-usdt", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const t0 = Date.now();

  console.log(`\n[server] [${requestId}] incoming GET /data-usdt`);

  const { x402: sigHeader, mpp: mppHeader } = detectPaymentHeader(req);

  // ── No payment header → 402 with both challenges ──────────────────────────
  if (!sigHeader && !mppHeader) {
    console.log(`[server] [${requestId}] no payment header → 402 (x402 + MPP)`);

    const mppChallengeId = createChallengeId(
      mppUsdt.method, mppUsdt.amount, mppUsdt.currency, mppUsdt.payTo, MPP_SECRET_KEY,
    );

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://localhost:${PORT}/data-usdt`,
        description: "Premium data endpoint (USDT, allowance scheme)",
        mimeType: "application/json",
      },
      accepts: [allowanceRequirements],
    };

    res
      .status(402)
      .set("Cache-Control", "no-store")
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
      .set("WWW-Authenticate", buildWwwAuthenticate({ ...mppUsdt, id: mppChallengeId }))
      .json({});
    return;
  }

  // ── x402 path ──────────────────────────────────────────────────────────────
  if (sigHeader) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(sigHeader);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payer = (paymentPayload as any)?.payload?.from ?? "unknown";
      console.log(`[server] [${requestId}] x402 decoded — payer: ${payer}`);
    } catch (err) {
      console.error(`[server] [${requestId}] failed to decode x402 header:`, err);
      res.status(400).json({ error: "Invalid PAYMENT-SIGNATURE header" });
      return;
    }

    console.log(`[server] [${requestId}] → POST ${FACILITATOR_URL}/verify`);
    const t1 = Date.now();

    let verified;
    try {
      verified = await facilitator.verify(paymentPayload, allowanceRequirements);
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
          resource: { url: `http://localhost:${PORT}/data-usdt` },
          accepts: [allowanceRequirements],
        }))
        .json({});
      return;
    }

    console.log(`[server] [${requestId}] → POST ${FACILITATOR_URL}/settle`);
    const t2 = Date.now();

    let settled;
    try {
      settled = await facilitator.settle(paymentPayload, allowanceRequirements);
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

    const total = Date.now() - t0;
    console.log(`[server] [${requestId}] ✓ done (x402) — total ${total}ms`);

    res
      .set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled))
      .json({
        message: "You paid for this! (USDT, allowance scheme)",
        requestId,
        timing: { totalMs: total, verifyMs: t2 - t1, settleMs: Date.now() - t2 },
        payment: {
          tx:       settled.transaction,
          payer:    verified.payer,
          network:  settled.network,
          amount:   "$0.0001 USDT",
          protocol: "x402",
          scheme:   "allowance",
        },
      });
    return;
  }

  // ── MPP path ───────────────────────────────────────────────────────────────
  await handleMppTempo(res, requestId, mppHeader!, mppUsdt, t0);
});

app.listen(PORT, () => {
  console.log(`\n[server] Ready — http://localhost:${PORT}`);
  console.log(`[server] Paid endpoint (exact):     GET http://localhost:${PORT}/data`);
  console.log(`[server] Paid endpoint (allowance): GET http://localhost:${PORT}/data-usdt`);
  console.log(`[server] Both endpoints accept: x402 (PAYMENT-SIGNATURE) or MPP (Authorization: Payment)`);
});
