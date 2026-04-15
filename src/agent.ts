/**
 * Steps 6, 7, 9, 10, 13, 16: x402 payment agent
 *
 * Usage:
 *   npm run agent                                            # step 6: hits bazaar endpoint
 *   TARGET_URL=http://localhost:4021/data npm run agent      # step 7: our own server
 *   PRIVATE_KEY=0x... TARGET_URL=... npm run agent           # step 16: second agent wallet
 */

import "dotenv/config";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { config } from "./config.js";

const PRIVATE_KEY = (process.env.PRIVATE_KEY ?? config.privateKey) as `0x${string}`;

// Step 6: call a live x402 endpoint (the example weather endpoint from x402.org)
// Override with TARGET_URL env var for step 7 (our own server)
// NOTE: we start with our own server as default since bazaar discovery requires runtime query
const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:4021/data";

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

// Build a ClientEvmSigner — bridges viem's strict types to x402's looser interface
const signer = toClientEvmSigner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient as any
);

console.log(`[agent] Wallet address : ${account.address}`);
console.log(`[agent] Target URL     : ${TARGET_URL}`);
console.log(`[agent] Network        : base-sepolia (eip155:84532)`);

// Check ETH and USDC balances
const ethBalance = await publicClient.getBalance({ address: account.address });
console.log(`[agent] ETH balance    : ${(Number(ethBalance) / 1e18).toFixed(6)} ETH`);

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const BALANCE_OF_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const usdcBalance = await publicClient.readContract({
  address: USDC_BASE_SEPOLIA,
  abi: BALANCE_OF_ABI,
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`[agent] USDC balance   : ${(Number(usdcBalance) / 1e6).toFixed(4)} USDC`);

if (ethBalance === 0n) {
  console.warn(`\n[agent] WARNING: No ETH for gas. Fund on Base Sepolia:`);
  console.warn(`  ${account.address}`);
  console.warn(`  Faucet: https://faucet.quicknode.com/base/sepolia`);
}
if (usdcBalance === 0n) {
  console.warn(`\n[agent] WARNING: No USDC. Get testnet USDC:`);
  console.warn(`  Address: ${account.address}`);
  console.warn(`  Faucet : https://faucet.circle.com  (Base Sepolia, 20 USDC)`);
  process.exit(1);
}

// Set up x402 client — registers BOTH v1 and v2 EVM exact schemes
const client = new x402Client();
registerExactEvmScheme(client, {
  signer,
  schemeOptions: { rpcUrl: config.rpcUrl },
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`\n[agent] Making request to ${TARGET_URL} ...`);
console.log(`[agent] (will auto-pay if 402 received)`);

const response = await fetchWithPayment(TARGET_URL);

if (!response.ok) {
  const text = await response.text();
  console.error(`\n[agent] ERROR ${response.status}: ${text}`);
  process.exit(1);
}

const data = await response.json();
console.log(`\n[agent] SUCCESS — response body:`);
console.log(JSON.stringify(data, null, 2));

// Decode and log the payment receipt from response headers (header: PAYMENT-RESPONSE)
const rawReceipt = response.headers.get("payment-response");
if (rawReceipt) {
  try {
    const receipt = JSON.parse(Buffer.from(rawReceipt, "base64").toString()) as Record<string, unknown>;
    console.log(`\n[agent] Payment receipt:`);
    console.log(`  success : ${receipt["success"]}`);
    console.log(`  tx      : ${receipt["transaction"] ?? "(none)"}`);
    console.log(`  payer   : ${receipt["payer"] ?? "(none)"}`);
    console.log(`  network : ${receipt["network"] ?? "(none)"}`);
  } catch {
    console.log(`[agent] Payment receipt (raw base64): ${rawReceipt.slice(0, 80)}...`);
  }
}
