/**
 * MPP payment agent — demonstrates the MPP/tempo charge flow:
 *
 *   Step 1: GET /data with no payment header → 402 with WWW-Authenticate: Payment
 *   Step 2: Parse challenge ID, recipient, amount, currency from the header
 *   Step 3: Submit USDC transfer on-chain (client pays gas, unlike x402)
 *   Step 4: Retry with Authorization: Payment containing the tx hash
 *   Step 5: Server verifies tx on Base Sepolia → returns 200 + Payment-Receipt
 */

import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config, USDC_ADDRESS, agentKey } from "./config.js";

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:4021/data";
const PRIVATE_KEY = agentKey();

const account    = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) });

console.log(`[mpp-agent] Wallet  : ${account.address}`);
console.log(`[mpp-agent] Target  : ${TARGET_URL}`);
console.log(`[mpp-agent] Network : Base Sepolia (eip155:84532)`);

// ── Balance checks ────────────────────────────────────────────────────────────
const ethBalance  = await publicClient.getBalance({ address: account.address });
const usdcBalance = await publicClient.readContract({
  address: USDC_ADDRESS,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`[mpp-agent] ETH     : ${(Number(ethBalance) / 1e18).toFixed(6)} ETH`);
console.log(`[mpp-agent] USDC    : ${(Number(usdcBalance) / 1e6).toFixed(4)} USDC`);

if (ethBalance === 0n) {
  console.error("\n[mpp-agent] ERROR: No ETH for gas. MPP requires the client to submit the on-chain tx.");
  console.error(`  Fund: ${account.address}`);
  process.exit(1);
}
if (usdcBalance === 0n) {
  console.error("\n[mpp-agent] ERROR: No USDC balance.");
  process.exit(1);
}

// ── Step 1: GET /data — expect 402 with MPP challenge ────────────────────────
console.log(`\n[mpp-agent] Step 1: GET ${TARGET_URL} (no payment header)...`);

const res402 = await fetch(TARGET_URL);
if (res402.status !== 402) {
  console.error(`[mpp-agent] Expected 402, got ${res402.status}`);
  process.exit(1);
}

const wwwAuth = res402.headers.get("www-authenticate");
if (!wwwAuth || !wwwAuth.startsWith("Payment ")) {
  console.error("[mpp-agent] No MPP WWW-Authenticate: Payment header in 402 response");
  console.error(`  Got: ${wwwAuth}`);
  process.exit(1);
}

console.log(`[mpp-agent] Got 402 with MPP challenge`);
console.log(`[mpp-agent] WWW-Authenticate: ${wwwAuth.slice(0, 100)}...`);

// Parse key=value pairs from the header
function parseHeaderParams(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) result[m[1]] = m[2];
  return result;
}

const params = parseHeaderParams(wwwAuth);
const { id: challengeId, method, amount, currency, recipient } = params;

if (!challengeId || !method || !amount || !currency || !recipient) {
  console.error("[mpp-agent] Missing required field in WWW-Authenticate header:", params);
  process.exit(1);
}

console.log(`[mpp-agent] Challenge ID : ${challengeId.slice(0, 24)}...`);
console.log(`[mpp-agent] Method       : ${method}`);
console.log(`[mpp-agent] Amount       : ${amount} atomic units ($${(Number(amount) / 1e6).toFixed(4)} USDC)`);
console.log(`[mpp-agent] Currency     : ${currency}`);
console.log(`[mpp-agent] Recipient    : ${recipient}`);

// ── Step 2: Submit USDC transfer on-chain ─────────────────────────────────────
console.log(`\n[mpp-agent] Step 2: Submitting USDC transfer on Base Sepolia...`);
console.log(`[mpp-agent] Sending ${amount} USDC → ${recipient}`);

const txHash = await walletClient.writeContract({
  address: currency as `0x${string}`,
  abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
  functionName: "transfer",
  args: [recipient as `0x${string}`, BigInt(amount)],
  gas: 100_000n, // skip estimation — public RPC sometimes rejects eth_estimateGas
});

console.log(`[mpp-agent] Tx submitted : ${txHash}`);
console.log(`[mpp-agent] Waiting for confirmation...`);

const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log(`[mpp-agent] Confirmed    : block ${receipt.blockNumber}, status=${receipt.status}`);

if (receipt.status !== "success") {
  console.error("[mpp-agent] Transaction reverted — cannot proceed");
  process.exit(1);
}

// ── Step 3: Retry with Authorization: Payment header ─────────────────────────
const payloadJson    = JSON.stringify({ intent: "charge", transaction: txHash });
const escapedPayload = payloadJson.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const authHeader     = `Payment id="${challengeId}", method="${method}", payload="${escapedPayload}"`;

console.log(`\n[mpp-agent] Step 3: Retrying with Authorization: Payment header...`);

const res200 = await fetch(TARGET_URL, {
  headers: { Authorization: authHeader },
});

console.log(`[mpp-agent] Response status : ${res200.status}`);

const paymentReceipt = res200.headers.get("payment-receipt");
if (paymentReceipt) {
  console.log(`[mpp-agent] Payment-Receipt : ${paymentReceipt}`);
}

if (!res200.ok) {
  const text = await res200.text();
  console.error(`\n[mpp-agent] FAILED: ${text}`);
  process.exit(1);
}

const data = await res200.json() as Record<string, unknown>;
console.log(`\n[mpp-agent] SUCCESS!`);
console.log(JSON.stringify(data, null, 2));
