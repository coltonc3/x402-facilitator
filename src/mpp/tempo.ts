/**
 * MPP Tempo "charge" verification for Base Sepolia.
 *
 * MPP's key difference from x402:
 *   x402   — client signs an authorization; server submits the on-chain tx
 *   MPP    — client submits the on-chain tx first, then presents the tx hash
 *
 * Verification reads the receipt from Base Sepolia and looks for an ERC-20 Transfer
 * event from the target token contract that sent at least `amount` to `payTo`.
 * No gas or wallet required on the server side — read-only chain access only.
 */

import { decodeEventLog } from "viem";
import type { MppVerifyResult } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const ERC20_TRANSFER_ABI = [{
  name: "Transfer",
  type: "event",
  inputs: [
    { name: "from",  type: "address", indexed: true  },
    { name: "to",    type: "address", indexed: true  },
    { name: "value", type: "uint256", indexed: false },
  ],
}] as const;

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function verifyTempoCharge(
  publicClient: AnyPublicClient,
  txHash: `0x${string}`,
  opts: {
    payTo:    `0x${string}`;
    currency: `0x${string}`;
    amount:   string;
  },
): Promise<MppVerifyResult> {
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch {
    return { isValid: false, invalidReason: "transaction not found on Base Sepolia" };
  }

  if (receipt.status !== "success") {
    return { isValid: false, invalidReason: "transaction reverted on-chain" };
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== opts.currency.toLowerCase()) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;

    try {
      const { args } = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const { from, to, value } = args as { from: string; to: string; value: bigint };
      if (
        to.toLowerCase() === opts.payTo.toLowerCase() &&
        value >= BigInt(opts.amount)
      ) {
        return { isValid: true, payer: from };
      }
    } catch {
      continue;
    }
  }

  return {
    isValid: false,
    invalidReason: `no matching token transfer to ${opts.payTo} found in tx`,
  };
}
