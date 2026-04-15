/**
 * Steps 11-16: Custom x402 Facilitator
 *
 * Implements /verify and /settle endpoints of the x402 facilitator protocol.
 * Uses @x402/core x402Facilitator with the EVM exact scheme on Base Sepolia.
 *
 * Features:
 * - Step 14: Whitelist (always grants server's own address — fake whitelist demo)
 * - Step 15: Blacklist (rejects specific payer addresses)
 * - Step 16: Per-address whitelist enforcement for new agents
 *
 * Environment variables:
 *   WHITELIST_ENABLED=true          — enforce whitelist (allow only WHITELIST addresses)
 *   BLACKLIST=0x...,0x...           — comma-separated addresses to block
 *   WHITELIST=0x...,0x...           — comma-separated allowed payers
 */

import "dotenv/config";
import express from "express";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { config, BASE_SEPOLIA } from "./config.js";

const PORT = config.facilitatorPort;

// ─── Access control lists ────────────────────────────────────────────────────
const WHITELIST_ENABLED = process.env.WHITELIST_ENABLED === "true";
const BLACKLIST = new Set(
  (process.env.BLACKLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
const WHITELIST = new Set(
  (process.env.WHITELIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

console.log(`[facilitator] Starting custom x402 facilitator`);
console.log(`[facilitator] Signer address  : ${config.payToAddress}`);
console.log(`[facilitator] Network         : ${BASE_SEPOLIA}`);
console.log(`[facilitator] Port            : ${PORT}`);
console.log(`[facilitator] Whitelist mode  : ${WHITELIST_ENABLED}`);
if (BLACKLIST.size) console.log(`[facilitator] Blacklist       : ${[...BLACKLIST].join(", ")}`);
if (WHITELIST.size) console.log(`[facilitator] Whitelist       : ${[...WHITELIST].join(", ")}`);

// ─── Blockchain clients ──────────────────────────────────────────────────────
const account = privateKeyToAccount(config.privateKey);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

// Build FacilitatorEvmSigner — bridges viem's strict types to x402's interface
const facilitatorSigner = toFacilitatorEvmSigner({
  address: account.address,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args) => publicClient.readContract(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyTypedData: (args) => publicClient.verifyTypedData(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContract: (args) => walletClient.writeContract(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendTransaction: (args) => walletClient.sendTransaction(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as any),
  getCode: (args) => publicClient.getCode(args),
});

// ─── x402 Facilitator ────────────────────────────────────────────────────────
const facilitator = new x402Facilitator();
facilitator.register(BASE_SEPOLIA, new ExactEvmScheme(facilitatorSigner));

// Hooks for logging
facilitator.onBeforeVerify(async (ctx) => {
  const payer = extractPayer(ctx.paymentPayload);
  console.log(`[facilitator] → verify  payer=${payer}`);
});
facilitator.onAfterVerify(async (ctx) => {
  console.log(`[facilitator] ← verify  isValid=${ctx.result.isValid} payer=${ctx.result.payer ?? "?"}`);
});
facilitator.onBeforeSettle(async (ctx) => {
  const payer = extractPayer(ctx.paymentPayload);
  console.log(`[facilitator] → settle  payer=${payer}`);
});
facilitator.onAfterSettle(async (ctx) => {
  console.log(`[facilitator] ← settle  success=${ctx.result.success} tx=${ctx.result.transaction ?? "?"}`);
});

// ─── ACL helper ─────────────────────────────────────────────────────────────
function extractPayer(paymentPayload: unknown): string {
  const p = paymentPayload as { payload?: { authorization?: { from?: string } } };
  return (p?.payload?.authorization?.from ?? "").toLowerCase();
}

// Step 14: "fake whitelist" — the facilitator's own address is always allowed,
// even when whitelist mode is on. This simulates a server granting itself access.
const FACILITATOR_OWN_ADDRESS = account.address.toLowerCase();

function checkAccess(payer: string): { allowed: boolean; reason?: string } {
  if (BLACKLIST.has(payer)) {
    return { allowed: false, reason: `address ${payer} is blacklisted` };
  }
  // Fake whitelist: facilitator's own address is always auto-approved
  if (payer === FACILITATOR_OWN_ADDRESS) {
    console.log(`[facilitator] ACL: auto-approved facilitator own address ${payer}`);
    return { allowed: true };
  }
  if (WHITELIST_ENABLED && WHITELIST.size > 0 && !WHITELIST.has(payer)) {
    return { allowed: false, reason: `address ${payer} is not whitelisted` };
  }
  return { allowed: true };
}

// ─── Express server ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    facilitator: "custom",
    network: BASE_SEPOLIA,
    whitelistEnabled: WHITELIST_ENABLED,
    blacklistSize: BLACKLIST.size,
    whitelistSize: WHITELIST.size,
  });
});

app.get("/supported", (_req, res) => {
  const supported = facilitator.getSupported();
  console.log(`[facilitator] /supported`);
  res.json(supported);
});

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as {
    paymentPayload: unknown;
    paymentRequirements: unknown;
  };

  const payer = extractPayer(paymentPayload);
  const access = checkAccess(payer);
  if (!access.allowed) {
    console.log(`[facilitator] /verify DENIED: ${access.reason}`);
    res.status(200).json({ isValid: false, invalidReason: access.reason, payer });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await facilitator.verify(paymentPayload as any, paymentRequirements as any);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[facilitator] /verify error:`, message);
    res.status(200).json({ isValid: false, invalidReason: message });
  }
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body as {
    paymentPayload: unknown;
    paymentRequirements: unknown;
  };

  const payer = extractPayer(paymentPayload);
  const access = checkAccess(payer);
  if (!access.allowed) {
    console.log(`[facilitator] /settle DENIED: ${access.reason}`);
    res.status(200).json({
      success: false,
      errorReason: access.reason,
      payer,
      transaction: "",
      network: BASE_SEPOLIA,
    });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await facilitator.settle(paymentPayload as any, paymentRequirements as any);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[facilitator] /settle error:`, message);
    res.status(200).json({
      success: false,
      errorReason: message,
      payer,
      transaction: "",
      network: BASE_SEPOLIA,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n[facilitator] Ready — http://localhost:${PORT}`);
  console.log(`[facilitator] Endpoints: POST /verify  POST /settle  GET /supported`);
});
