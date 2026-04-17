/**
 * One-time setup: approve the facilitator to spend tokens on behalf of an agent.
 *
 * Run this before using the allowance-based payment scheme (e.g. /data-usdt).
 * Only needs to be run once per agent per token — the approval persists on-chain.
 *
 * Usage:
 *   npm run approve            # approve for agent1
 *   AGENT=2 npm run approve    # approve for agent2
 */

import "dotenv/config";
import { createPublicClient, createWalletClient, http, maxUint256, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { config, FACILITATOR_ADDRESS, USDT_ADDRESS } from "./config.js";
import { agentKey } from "./config.js";

const PRIVATE_KEY = agentKey();
const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(config.rpcUrl),
});

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

const DECIMALS_ABI = [{
  name: "decimals", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "uint8" }],
}] as const;

const agentNum = process.env.AGENT === "2" ? "agent2" : "agent1";
console.log(`[approve] Agent       : ${agentNum} (${account.address})`);
console.log(`[approve] Facilitator : ${FACILITATOR_ADDRESS}`);
console.log(`[approve] Token       : ${USDT_ADDRESS}`);

// Check existing allowance
const existing: bigint = await publicClient.readContract({
  address: USDT_ADDRESS,
  abi: ALLOWANCE_ABI,
  functionName: "allowance",
  args: [account.address, FACILITATOR_ADDRESS],
});

const decimals: number = await publicClient.readContract({
  address: USDT_ADDRESS,
  abi: DECIMALS_ABI,
  functionName: "decimals",
});

if (existing > 0n) {
  console.log(`[approve] Current allowance: ${formatUnits(existing, decimals)} (already approved)`);
  if (existing === maxUint256) {
    console.log(`[approve] Already at max allowance — nothing to do.`);
    process.exit(0);
  }
}

console.log(`[approve] Approving facilitator for unlimited spend…`);

const hash = await walletClient.writeContract({
  address: USDT_ADDRESS,
  abi: APPROVE_ABI,
  functionName: "approve",
  args: [FACILITATOR_ADDRESS, maxUint256],
});

console.log(`[approve] Tx submitted: ${hash}`);
console.log(`[approve] Waiting for confirmation…`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`[approve] Confirmed in block ${receipt.blockNumber}`);
console.log(`[approve] Done. Agent ${account.address} can now pay via the allowance scheme.`);
