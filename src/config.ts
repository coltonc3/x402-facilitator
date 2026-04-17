import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

export const config = {
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  agent2Key: process.env.AGENT2_PRIVATE_KEY as `0x${string}`,
  serverPrivateKey: process.env.SERVER_PRIVATE_KEY as `0x${string}`,
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
  payToAddress: process.env.PAY_TO_ADDRESS as `0x${string}`,
  apiServerPort: parseInt(process.env.API_SERVER_PORT ?? "4021"),
  facilitatorPort: parseInt(process.env.FACILITATOR_PORT ?? "4022"),
  coinbaseFacilitatorUrl:
    process.env.COINBASE_FACILITATOR_URL ?? "https://x402.org/facilitator",
};

// Base Sepolia CAIP-2 network identifier
export const BASE_SEPOLIA = "eip155:84532" as const;

// USDC on Base Sepolia
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// USDT on Base Sepolia — set USDT_ADDRESS in .env once you have a contract.
// Falls back to USDC so the allowance scheme can be tested on testnet without real USDT.
export const USDT_ADDRESS = (process.env.USDT_ADDRESS ?? USDC_ADDRESS) as `0x${string}`;

// Derived from SERVER_PRIVATE_KEY — the address that submits on-chain transactions
export const FACILITATOR_ADDRESS: `0x${string}` = config.serverPrivateKey
  ? privateKeyToAccount(config.serverPrivateKey).address
  : "0x0000000000000000000000000000000000000000";

if (!config.privateKey) {
  throw new Error("PRIVATE_KEY env var is required");
}
if (!config.payToAddress) {
  throw new Error("PAY_TO_ADDRESS env var is required");
}

/** Returns the private key for AGENT=1 (default) or AGENT=2 */
export function agentKey(): `0x${string}` {
  if (process.env.AGENT === "2") {
    if (!config.agent2Key) throw new Error("AGENT2_PRIVATE_KEY env var is required for AGENT=2");
    return config.agent2Key;
  }
  return config.privateKey;
}
