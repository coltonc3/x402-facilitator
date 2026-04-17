/**
 * x402 Demo Dashboard
 *
 * Runs server + facilitator + dashboard in a single process.
 * Visualizes the full payment flow in real-time across three panels.
 *
 * Usage:
 *   npm run ui
 *   open http://localhost:4023
 *
 * Ports used: 4021 (server), 4022 (facilitator), 4023 (dashboard)
 * Kill any existing server/facilitator processes before running.
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Facilitator
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { AllowanceFacilitatorScheme } from "./schemes/allowance.js";

// Server
import {
  HTTPFacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

// Agent
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { registerAllowanceScheme } from "./schemes/allowance.js";

import { config, BASE_SEPOLIA, USDC_ADDRESS, USDT_ADDRESS } from "./config.js";

const FACILITATOR_PORT = config.facilitatorPort;
const SERVER_PORT = config.apiServerPort;
const DASHBOARD_PORT = 4023;

// ─── SSE broadcast ─────────────────────────────────────────────────────────────
type Entity = "agent" | "server" | "facilitator";

const sseClients: express.Response[] = [];

function broadcast(data: object) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

function emit(entity: Entity, type: string, message: string) {
  broadcast({ entity, type, message, t: new Date().toISOString().slice(11, 23) });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractPayer(paymentPayload: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = paymentPayload as any;
  return (
    p?.payload?.authorization?.from ??  // EIP-3009 exact scheme
    p?.payload?.from ??                 // allowance scheme
    ""
  ).toLowerCase();
}

function short(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ─── Blockchain clients ────────────────────────────────────────────────────────
const facilitatorAccount = privateKeyToAccount(config.serverPrivateKey);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});
const walletClient = createWalletClient({
  account: facilitatorAccount,
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

// ─── x402 Facilitator core ────────────────────────────────────────────────────
const facilitatorCore = new x402Facilitator();

const facilitatorSigner = toFacilitatorEvmSigner({
  address: facilitatorAccount.address,
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

facilitatorCore.register(BASE_SEPOLIA, new ExactEvmScheme(facilitatorSigner));

// Allowance scheme — for tokens without EIP-3009 (e.g. USDT)
const allowanceSigner = {
  address: facilitatorAccount.address,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract:              (args: any) => publicClient.readContract(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyTypedData:           (args: any) => publicClient.verifyTypedData(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContract:             (args: any) => walletClient.writeContract(args as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitForTransactionReceipt: (args: any) => publicClient.waitForTransactionReceipt(args as any),
};
facilitatorCore.register(BASE_SEPOLIA, new AllowanceFacilitatorScheme(allowanceSigner));

facilitatorCore.onBeforeVerify(async (ctx) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheme = (ctx.paymentPayload as any)?.scheme ?? "exact";
  const payer = extractPayer(ctx.paymentPayload);
  emit("facilitator", "verify-start", `← /verify  payer: ${short(payer)}`);
  emit("facilitator", "detail", `  scheme: ${scheme}  checking signature + balance`);
});
facilitatorCore.onAfterVerify(async (ctx) => {
  if (ctx.result.isValid) {
    emit("facilitator", "ok", `✓ valid  payer: ${short(ctx.result.payer ?? "")}`);
  } else {
    emit("facilitator", "err", `✗ invalid: ${ctx.result.invalidReason}`);
  }
});
facilitatorCore.onBeforeSettle(async (ctx) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheme = (ctx.paymentPayload as any)?.scheme ?? "exact";
  const payer = extractPayer(ctx.paymentPayload);
  emit("facilitator", "settle-start", `← /settle  from: ${short(payer)}`);
  if (scheme === "allowance") {
    emit("facilitator", "detail", `  transferFrom  (pre-approved allowance)`);
  } else {
    emit("facilitator", "detail", `  transferWithAuthorization  (1 tx)`);
  }
  emit("facilitator", "detail", `  gas wallet: ${short(facilitatorAccount.address)}`);
});
facilitatorCore.onAfterSettle(async (ctx) => {
  if (ctx.result.success) {
    emit("facilitator", "ok", `✓ confirmed  tx: ${(ctx.result.transaction ?? "").slice(0, 14)}…`);
  } else {
    emit("facilitator", "err", `✗ failed: ${ctx.result.errorReason}`);
  }
});

// ─── Per-run ACL (set by demo handler) ────────────────────────────────────────
let demoBlacklist = new Set<string>();

// ─── Facilitator server ────────────────────────────────────────────────────────
const facilitatorApp = express();
facilitatorApp.use(express.json({ limit: "1mb" }));

facilitatorApp.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  const payer = extractPayer(paymentPayload);

  if (demoBlacklist.has(payer)) {
    emit("facilitator", "acl-deny", `✗ ACL denied: ${short(payer)} is blacklisted`);
    res.json({ isValid: false, invalidReason: `${payer} is blacklisted`, payer });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await facilitatorCore.verify(paymentPayload as any, paymentRequirements as any);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ isValid: false, invalidReason: message });
  }
});

facilitatorApp.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  const payer = extractPayer(paymentPayload);

  if (demoBlacklist.has(payer)) {
    emit("facilitator", "acl-deny", `✗ ACL denied: ${short(payer)} is blacklisted`);
    res.json({ success: false, errorReason: `${payer} is blacklisted`, payer, transaction: "", network: BASE_SEPOLIA });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await facilitatorCore.settle(paymentPayload as any, paymentRequirements as any);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ success: false, errorReason: message, payer, transaction: "", network: BASE_SEPOLIA });
  }
});

// ─── Server app ────────────────────────────────────────────────────────────────
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: BASE_SEPOLIA,
  asset: USDC_ADDRESS,
  amount: "100",
  payTo: config.payToAddress,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const allowanceReq: PaymentRequirements = {
  scheme: "allowance",
  network: BASE_SEPOLIA,
  asset: USDT_ADDRESS,
  amount: "100",
  payTo: config.payToAddress,
  maxTimeoutSeconds: 300,
  extra: { facilitatorAddress: facilitatorAccount.address },
};

const facilitatorHttpClient = new HTTPFacilitatorClient({
  url: `http://localhost:${FACILITATOR_PORT}`,
});

const serverApp = express();
serverApp.use(express.json());

serverApp.get("/data", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const sigHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

  if (!sigHeader) {
    emit("server", "request", `← GET /data  [${requestId}]`);
    emit("server", "detail", `  no PAYMENT-SIGNATURE header`);
    emit("server", "response-402", `→ 402 PAYMENT-REQUIRED`);
    emit("server", "detail", `  scheme:exact  amount:100 ($0.0001)  payTo:${short(config.payToAddress)}`);

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://localhost:${SERVER_PORT}/data`,
        description: "Premium data endpoint",
        mimeType: "application/json",
      },
      accepts: [requirements],
    };

    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired)).json({});
    return;
  }

  emit("server", "request", `← GET /data + PAYMENT-SIGNATURE  [${requestId}]`);

  let paymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(sigHeader);
    emit("server", "detail", `  payer: ${short(extractPayer(paymentPayload))}`);
  } catch {
    res.status(400).json({ error: "Invalid payment header" });
    return;
  }

  emit("server", "to-facilitator", `→ POST facilitator/verify`);

  let verified;
  try {
    verified = await facilitatorHttpClient.verify(paymentPayload, requirements);
  } catch {
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  if (!verified.isValid) {
    emit("server", "verify-fail", `← verify: ✗ ${verified.invalidReason}`);
    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({
      x402Version: 2,
      error: verified.invalidReason ?? "Payment invalid",
      resource: { url: `http://localhost:${SERVER_PORT}/data` },
      accepts: [requirements],
    })).json({});
    return;
  }

  emit("server", "verify-ok", `← verify: ✓ valid`);
  emit("server", "to-facilitator", `→ POST facilitator/settle`);

  let settled;
  try {
    settled = await facilitatorHttpClient.settle(paymentPayload, requirements);
  } catch {
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  if (!settled.success) {
    emit("server", "settle-fail", `← settle: ✗ ${settled.errorReason}`);
    res.status(402).json({ error: "Settlement failed" });
    return;
  }

  emit("server", "settle-ok", `← settle: ✓ tx: ${(settled.transaction ?? "").slice(0, 14)}…`);
  emit("server", "response-200", `→ 200 OK + PAYMENT-RESPONSE`);

  res.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled)).json({
    message: "You paid for this!",
    requestId,
    payment: {
      tx: settled.transaction,
      payer: verified.payer,
      network: settled.network,
      amount: "$0.0001 USDC",
    },
  });
});

serverApp.get("/data-usdt", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const sigHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

  if (!sigHeader) {
    emit("server", "request", `← GET /data-usdt  [${requestId}]`);
    emit("server", "detail", `  no PAYMENT-SIGNATURE header`);
    emit("server", "response-402", `→ 402 PAYMENT-REQUIRED`);
    emit("server", "detail", `  scheme:allowance  amount:100 ($0.0001 USDT)  payTo:${short(config.payToAddress)}`);

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://localhost:${SERVER_PORT}/data-usdt`,
        description: "Premium data endpoint (USDT, allowance scheme)",
        mimeType: "application/json",
      },
      accepts: [allowanceReq],
    };

    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired)).json({});
    return;
  }

  emit("server", "request", `← GET /data-usdt + PAYMENT-SIGNATURE  [${requestId}]`);

  let paymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(sigHeader);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payer = (paymentPayload as any)?.payload?.from ?? "unknown";
    emit("server", "detail", `  payer: ${short(payer)}`);
  } catch {
    res.status(400).json({ error: "Invalid payment header" });
    return;
  }

  emit("server", "to-facilitator", `→ POST facilitator/verify`);

  let verified;
  try {
    verified = await facilitatorHttpClient.verify(paymentPayload, allowanceReq);
  } catch {
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  if (!verified.isValid) {
    emit("server", "verify-fail", `← verify: ✗ ${verified.invalidReason}`);
    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({
      x402Version: 2,
      error: verified.invalidReason ?? "Payment invalid",
      resource: { url: `http://localhost:${SERVER_PORT}/data-usdt` },
      accepts: [allowanceReq],
    })).json({});
    return;
  }

  emit("server", "verify-ok", `← verify: ✓ valid`);
  emit("server", "to-facilitator", `→ POST facilitator/settle`);

  let settled;
  try {
    settled = await facilitatorHttpClient.settle(paymentPayload, allowanceReq);
  } catch {
    res.status(502).json({ error: "Facilitator unreachable" });
    return;
  }

  if (!settled.success) {
    emit("server", "settle-fail", `← settle: ✗ ${settled.errorReason}`);
    res.status(402).json({ error: "Settlement failed" });
    return;
  }

  emit("server", "settle-ok", `← settle: ✓ tx: ${(settled.transaction ?? "").slice(0, 14)}…`);
  emit("server", "response-200", `→ 200 OK + PAYMENT-RESPONSE`);

  res.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settled)).json({
    message: "You paid for this! (USDT, allowance scheme)",
    requestId,
    payment: {
      tx: settled.transaction,
      payer: verified.payer,
      network: settled.network,
      amount: "$0.0001 USDT",
      scheme: "allowance",
    },
  });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────
const dashboardApp = express();
dashboardApp.use(express.json());

dashboardApp.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  sseClients.push(res);
  req.on("close", () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

const USDC_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

dashboardApp.get("/balances", async (_req, res) => {
  const wallets = [
    { name: "Agent1", address: "0xB655E8450EF9D07E5B555CF19B7915329B53dbcA" as `0x${string}` },
    { name: "Agent2", address: "0xDD90f58b3A6c7AA2386F620cc2280e9183Bbbf76" as `0x${string}` },
    { name: "Facilitator", address: facilitatorAccount.address },
    { name: "Server", address: config.payToAddress },
  ];
  const results = await Promise.all(wallets.map(async (w) => {
    const [eth, usdc] = await Promise.all([
      publicClient.getBalance({ address: w.address }),
      publicClient.readContract({ address: USDC_ADDRESS as `0x${string}`, abi: USDC_ABI, functionName: "balanceOf", args: [w.address] }),
    ]);
    return { ...w, eth: parseFloat(formatEther(eth)).toFixed(6), usdc: parseFloat(formatUnits(usdc, 6)).toFixed(4) };
  }));
  res.json(results);
});

let running = false;

dashboardApp.post("/demo", async (req, res) => {
  if (running) { res.json({ ok: false, error: "Already running" }); return; }
  running = true;

  const blocked  = req.query.blocked === "true";
  const useUsdt  = req.query.usdt === "true";
  const agentNum = req.query.agent === "2" ? "2" : "1";
  const agentPrivKey = agentNum === "2" ? config.agent2Key : config.privateKey;
  const agentAccount = privateKeyToAccount(agentPrivKey);

  demoBlacklist = blocked ? new Set([agentAccount.address.toLowerCase()]) : new Set();

  broadcast({ type: "clear" });

  // Emit initial context for each panel
  emit("facilitator", "info", `signer: ${short(facilitatorAccount.address)}`);
  if (blocked) emit("facilitator", "acl-warn", `⚠ blacklist active: ${short(agentAccount.address)}`);
  emit("server", "info", `payTo: ${short(config.payToAddress)}`);
  emit("agent", "info", `wallet (agent${agentNum}): ${agentAccount.address}`);

  // Build agent client with an instrumented fetch that emits events at each hop
  const agentPublicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signer = toClientEvmSigner(agentAccount as any, agentPublicClient as any);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer, schemeOptions: { rpcUrl: config.rpcUrl } });
  registerAllowanceScheme(client, { signer });

  const endpoint = useUsdt ? "/data-usdt" : "/data";

  // Auto-approve facilitator if running the allowance/USDT demo and allowance is insufficient
  if (useUsdt) {
    const ALLOWANCE_ABI = [{
      name: "allowance", type: "function", stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    const APPROVE_ABI = [{
      name: "approve", type: "function", stateMutability: "nonpayable",
      inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
      outputs: [{ name: "", type: "bool" }],
    }] as const;

    const allowance: bigint = await publicClient.readContract({
      address: USDT_ADDRESS,
      abi: ALLOWANCE_ABI,
      functionName: "allowance",
      args: [agentAccount.address, facilitatorAccount.address],
    });

    if (allowance < 100n) {
      emit("agent", "detail", `  no allowance — approving facilitator first…`);
      const agentWalletClient = createWalletClient({
        account: agentAccount,
        chain: baseSepolia,
        transport: http(config.rpcUrl),
      });
      const hash = await agentWalletClient.writeContract({
        address: USDT_ADDRESS,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [facilitatorAccount.address, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      emit("agent", "detail", `  ✓ approved facilitator`);
    }
  }
  const instrumentedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const r = new Request(input, init);
    const hasPayment = r.headers.has("payment-signature") || r.headers.has("x-payment");

    if (!hasPayment) {
      emit("agent", "request", `→ GET ${endpoint}`);
      emit("agent", "detail", `  no payment header — expecting 402`);
    } else {
      emit("agent", "retry", `→ GET ${endpoint} + PAYMENT-SIGNATURE`);
    }

    const response = await fetch(input, init);

    if (!hasPayment && response.status === 402) {
      emit("agent", "received-402", `← 402 PAYMENT-REQUIRED`);
      emit("agent", "detail", `  reading payment requirements…`);
      if (useUsdt) {
        emit("agent", "signing", `  signing allowance payment authorization (off-chain)`);
        emit("agent", "detail", `  facilitator will call transferFrom`);
      } else {
        emit("agent", "signing", `  signing EIP-3009 authorization (off-chain)`);
        emit("agent", "detail", `  to: ${short(config.payToAddress)}`);
      }
      emit("agent", "detail", `  from: ${short(agentAccount.address)}`);
      emit("agent", "detail", `  amount: 100 USDC units ($0.0001)`);
    }

    return response;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchWithPayment = wrapFetchWithPayment(instrumentedFetch as any, client);

  try {
    const response = await fetchWithPayment(`http://localhost:${SERVER_PORT}${endpoint}`);
    if (response.ok) {
      const data = await response.json() as { payment?: { tx?: string; scheme?: string } };
      emit("agent", "success", `← 200 OK`);
      emit("agent", "detail", `  tx: ${data.payment?.tx?.slice(0, 20)}…`);
      const token = useUsdt ? "USDT" : "USDC";
      emit("agent", "detail", `  paid $0.0001 ${token} ✓  scheme: ${data.payment?.scheme ?? "exact"}`);

      res.json({ ok: true });
    } else {
      emit("agent", "err", `← ${response.status} — payment rejected`);
      res.json({ ok: false });
    }
  } catch (err) {
    emit("agent", "err", `✗ ${err instanceof Error ? err.message : String(err)}`);
    res.json({ ok: false });
  } finally {
    running = false;
  }
});

dashboardApp.get("/", (_req, res) => res.send(HTML));

// ─── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Payment Flow</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0d1117; color: #c9d1d9;
  font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header {
  padding: 12px 20px; border-bottom: 1px solid #21262d;
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
h1 { font-size: 15px; color: #f0f6fc; font-weight: 600; letter-spacing: .5px; }
.controls { display: flex; gap: 8px; margin-left: auto; align-items: center; }
button {
  background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
  padding: 5px 12px; border-radius: 5px; cursor: pointer; font-size: 12px;
  font-family: inherit; transition: background .15s;
}
button:hover:not(:disabled) { background: #30363d; }
button.run  { background: #1a3a26; border-color: #2ea043; color: #3fb950; }
button.run:hover:not(:disabled) { background: #2ea043; color: #fff; }
button.usdt { background: #1a2e20; border-color: #2ea043; color: #56d364; }
button.usdt:hover:not(:disabled) { background: #2ea043; color: #fff; }
button.blocked { background: #3a1a1a; border-color: #a04040; color: #f85149; }
button.blocked:hover:not(:disabled) { background: #a04040; color: #fff; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

.balances {
  display: flex; gap: 24px; padding: 8px 20px;
  border-bottom: 1px solid #21262d; font-size: 11px; flex-shrink: 0;
}
.bal { display: flex; flex-direction: column; gap: 1px; }
.bal-name { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
.bal-val  { color: #c9d1d9; }

.grid {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  flex: 1; overflow: hidden;
}
.panel { display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid #21262d; }
.panel:last-child { border-right: none; }

.panel-head { padding: 10px 14px; border-bottom: 1px solid #21262d; flex-shrink: 0; }
.panel-title { font-size: 13px; font-weight: 700; letter-spacing: .5px; margin-bottom: 2px; }
.panel-sub   { font-size: 10px; color: #8b949e; }

.agent       .panel-title { color: #58a6ff; }
.server      .panel-title { color: #3fb950; }
.facilitator .panel-title { color: #bc8cff; }

.log { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }

.msg {
  padding: 4px 8px; border-radius: 4px; font-size: 11.5px;
  line-height: 1.45; border-left: 3px solid #21262d;
}
.t { color: #484f58; font-size: 10px; margin-right: 5px; }

.agent       .msg        { border-color: #1c2d46; }
.agent       .msg.info   { color: #8b949e; }
.agent       .msg.request{ border-color: #58a6ff; }
.agent       .msg.retry  { border-color: #58a6ff; font-weight: 600; }
.agent       .msg.received-402 { border-color: #e3b341; color: #e3b341; }
.agent       .msg.signing{ border-color: #e3b341; }
.agent       .msg.success{ border-color: #3fb950; color: #3fb950; font-weight: 600; }
.agent       .msg.err    { border-color: #f85149; color: #f85149; }
.agent       .msg.detail { border-color: #21262d; color: #8b949e; font-size: 11px; }

.server      .msg             { border-color: #1a2e1a; }
.server      .msg.info        { color: #8b949e; }
.server      .msg.request     { border-color: #3fb950; }
.server      .msg.to-facilitator { border-color: #bc8cff; }
.server      .msg.verify-ok,
.server      .msg.settle-ok   { border-color: #3fb950; color: #3fb950; }
.server      .msg.verify-fail,
.server      .msg.settle-fail { border-color: #f85149; color: #f85149; }
.server      .msg.response-402{ border-color: #e3b341; color: #e3b341; }
.server      .msg.response-200{ border-color: #3fb950; color: #3fb950; font-weight: 600; }
.server      .msg.detail      { border-color: #21262d; color: #8b949e; font-size: 11px; }

.facilitator .msg             { border-color: #1e1a2e; }
.facilitator .msg.info        { color: #8b949e; }
.facilitator .msg.acl-warn    { border-color: #e3b341; color: #e3b341; }
.facilitator .msg.verify-start,
.facilitator .msg.settle-start{ border-color: #bc8cff; }
.facilitator .msg.ok          { border-color: #3fb950; color: #3fb950; font-weight: 600; }
.facilitator .msg.err         { border-color: #f85149; color: #f85149; }
.facilitator .msg.acl-deny    { border-color: #f85149; color: #f85149; font-weight: 600; }
.facilitator .msg.detail      { border-color: #21262d; color: #8b949e; font-size: 11px; }

.log::-webkit-scrollbar       { width: 4px; }
.log::-webkit-scrollbar-track { background: transparent; }
.log::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
</style>
</head>
<body>
<header>
  <h1>x402 Payment Flow</h1>
  <div class="controls">
    <button class="run"     id="runBtn"     onclick="run(false, false)">▶ Run Payment</button>
    <button class="usdt"    id="usdtBtn"    onclick="run(false, true)">$ Run USDT</button>
    <button class="blocked" id="blockedBtn" onclick="run(true,  false)">✗ Run Blocked</button>
    <button onclick="clearLogs()">Clear</button>
  </div>
</header>
<div class="balances" id="balances">Loading…</div>
<div class="grid">
  <div class="panel agent">
    <div class="panel-head">
      <div class="panel-title">Agent</div>
      <div class="panel-sub">signs EIP-3009 / allowance auth · never submits txs</div>
    </div>
    <div class="log" id="agent-log"></div>
  </div>
  <div class="panel server">
    <div class="panel-head">
      <div class="panel-title">Server</div>
      <div class="panel-sub">issues 402 · delegates verify + settle</div>
    </div>
    <div class="log" id="server-log"></div>
  </div>
  <div class="panel facilitator">
    <div class="panel-head">
      <div class="panel-title">Facilitator</div>
      <div class="panel-sub">verifies · submits on-chain tx · pays gas</div>
    </div>
    <div class="log" id="facilitator-log"></div>
  </div>
</div>
<script>
const es = new EventSource('/events');
es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'clear') { clearLogs(); return; }
  const log = document.getElementById(ev.entity + '-log');
  if (!log) return;
  const d = document.createElement('div');
  d.className = 'msg ' + ev.type;
  d.innerHTML = '<span class="t">' + ev.t + '</span>' + ev.message;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
};

async function run(blocked, usdt = false) {
  const runBtn     = document.getElementById('runBtn');
  const usdtBtn    = document.getElementById('usdtBtn');
  const blockedBtn = document.getElementById('blockedBtn');
  [runBtn, usdtBtn, blockedBtn].forEach(b => b.disabled = true);
  const activeBtn = usdt ? usdtBtn : blocked ? blockedBtn : runBtn;
  activeBtn.textContent = '⏳ Running…';
  const params = new URLSearchParams();
  if (blocked) params.set('blocked', 'true');
  if (usdt)    params.set('usdt', 'true');
  const qs = params.toString();
  try {
    await fetch('/demo' + (qs ? '?' + qs : ''), { method: 'POST' });
  } finally {
    [runBtn, usdtBtn, blockedBtn].forEach(b => b.disabled = false);
    runBtn.textContent     = '▶ Run Payment';
    usdtBtn.textContent    = '$ Run USDT';
    blockedBtn.textContent = '✗ Run Blocked';
    loadBalances();
  }
}

function clearLogs() {
  ['agent','server','facilitator'].forEach(id =>
    document.getElementById(id + '-log').innerHTML = '');
}

async function loadBalances() {
  const data = await fetch('/balances').then(r => r.json());
  document.getElementById('balances').innerHTML = data.map(w =>
    '<div class="bal"><span class="bal-name">' + w.name + '</span>' +
    '<span class="bal-val">' + w.usdc + ' USDC · ' + w.eth + ' ETH</span></div>'
  ).join('');
}

loadBalances();
</script>
</body>
</html>`;

// ─── Start all three servers ───────────────────────────────────────────────────
facilitatorApp.listen(FACILITATOR_PORT, () =>
  console.log(`[facilitator] Ready — http://localhost:${FACILITATOR_PORT}`)
);

serverApp.listen(SERVER_PORT, () =>
  console.log(`[server]      Ready — http://localhost:${SERVER_PORT}`)
);

dashboardApp.listen(DASHBOARD_PORT, () => {
  console.log(`[dashboard]   Ready — http://localhost:${DASHBOARD_PORT}`);
  console.log(`\n→ Open http://localhost:${DASHBOARD_PORT}`);
});
