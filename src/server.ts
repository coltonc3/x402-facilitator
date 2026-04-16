/**
 * Step 5 & 8: x402-enabled API server
 *
 * Starts an Express server with a paid /data endpoint.
 * The facilitator URL is controlled by FACILITATOR_URL env var so we can
 * switch between Coinbase's facilitator (step 8) and our own (step 12).
 *
 * Default (step 5):  uses https://x402.org/facilitator (Coinbase testnet)
 * Step 8:            FACILITATOR_URL=https://x402.org/facilitator (same)
 * Step 12:           FACILITATOR_URL=http://localhost:4022
 */

import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config, BASE_SEPOLIA } from "./config.js";

const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? config.coinbaseFacilitatorUrl;
const PORT = config.apiServerPort;

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

console.log(`[server] Starting x402-enabled API server`);
console.log(`[server] Pay-to address : ${config.payToAddress}`);
console.log(`[server] Facilitator    : ${FACILITATOR_URL}`);
console.log(`[server] Network        : ${BASE_SEPOLIA}`);
console.log(`[server] Port           : ${PORT}`);

const app = express();
app.use(express.json());

// x402 payment middleware — protects /data at $0.001 per request
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /data": {
        accepts: {
          scheme: "exact",
          payTo: config.payToAddress,
          price: "$0.0001",
          network: BASE_SEPOLIA,
        },
        description: "Premium data endpoint (x402 prototype)",
        mimeType: "application/json",
      },
    },
    facilitatorClient,
    [{ network: BASE_SEPOLIA, server: new ExactEvmScheme() }]
  )
);

// Health check — no payment required
app.get("/health", (_req, res) => {
  res.json({ status: "ok", facilitator: FACILITATOR_URL, payTo: config.payToAddress });
});

// Paid endpoint — only reachable once payment is verified and settled
app.get("/data", (req, res) => {
  // The x402 middleware injects PAYMENT-RESPONSE header after successful settlement
  const paymentResp = req.headers["payment-response"] as string | undefined;
  let parsed: unknown = null;
  if (paymentResp) {
    try { parsed = JSON.parse(Buffer.from(paymentResp, "base64").toString()); } catch {}
  }

  console.log(`[server] /data — payment accepted`);
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    console.log(`[server]   tx   : ${p["transaction"] ?? "(unknown)"}`);
    console.log(`[server]   payer: ${p["payer"] ?? "(unknown)"}`);
  }

  res.json({
    message: "You paid for this!",
    timestamp: new Date().toISOString(),
    network: BASE_SEPOLIA,
    payTo: config.payToAddress,
    facilitator: FACILITATOR_URL,
    payment: parsed,
  });
});

app.listen(PORT, () => {
  console.log(`\n[server] Ready — http://localhost:${PORT}`);
  console.log(`[server] Paid endpoint: GET http://localhost:${PORT}/data`);
});
