import "dotenv/config";

export const config = {
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  agent2Key: process.env.AGENT2_PRIVATE_KEY as `0x${string}`,
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
