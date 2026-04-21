/**
 * ERC-20 allowance-based x402 payment scheme.
 *
 * For tokens that implement neither EIP-3009 (transferWithAuthorization) nor
 * EIP-2612 (permit) — notably Tether USDT — this is the only option that keeps
 * the agent gasless per-payment. The agent pre-approves the facilitator once
 * (on-chain, requires ETH), then signs a typed authorization for each request
 * (off-chain, no ETH needed).
 *
 * FLOW:
 *   Setup (once):  agent → approve(facilitator, budget) on-chain
 *   Per-request:   agent signs { from, to, token, amount, nonce, deadline }
 *                  facilitator verifies signature + checks allowance/balance
 *                  facilitator calls transferFrom(agent, payTo, amount)
 *
 * TRADEOFFS vs EIP-2612 permit:
 *   + Cheaper per payment (1 tx vs 2)
 *   + Works with USDT and other non-permit tokens
 *   - Requires one upfront approve() tx (agent needs ETH once)
 *   - Approval persists; agent must manage their own exposure
 *
 * TODO: Replace this scheme with Uniswap Permit2.
 * Permit2 is a singleton contract that brings EIP-2612-style signed transfers
 * to ANY ERC-20 token, including USDT. The agent approves Permit2 once per token
 * (same upfront ETH cost as this scheme), then uses signed PermitTransferFrom
 * messages for every subsequent payment — no need for a custom scheme or a custom
 * facilitator contract. It also provides better nonce handling (bitmap-based,
 * cheaper than a registry) and expiry built into the protocol.
 * See: https://blog.uniswap.org/permit2-and-universal-router
 *
 * REPLAY PROTECTION:
 *   Each signed message contains a random nonce + deadline. The facilitator
 *   tracks used nonces in memory (resets on restart — acceptable for a
 *   prototype; production would use an on-chain registry or persistent store).
 */

import type { x402Client } from "@x402/fetch";

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const TRANSFER_FROM_ABI = [{
  name: "transferFrom", type: "function", stateMutability: "nonpayable",
  inputs: [
    { name: "from",  type: "address" },
    { name: "to",    type: "address" },
    { name: "value", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

const ALLOWANCE_ABI = [{
  name: "allowance", type: "function", stateMutability: "view",
  inputs: [
    { name: "owner",   type: "address" },
    { name: "spender", type: "address" },
  ],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const BALANCE_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs:  [{ name: "account", type: "address" }],
  outputs: [{ name: "",        type: "uint256" }],
}] as const;

// ─── EIP-712 types ─────────────────────────────────────────────────────────────
// The domain's verifyingContract is the facilitator address, which binds each
// signature to a specific facilitator and prevents cross-facilitator replay.
const PAYMENT_TYPES = {
  Payment: [
    { name: "from",     type: "address" },
    { name: "to",       type: "address" },
    { name: "token",    type: "address" },
    { name: "amount",   type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ─── Payload shape carried in PAYMENT-SIGNATURE header ────────────────────────
interface AllowancePayload {
  from:      `0x${string}`;
  to:        `0x${string}`;  // payTo
  token:     `0x${string}`;
  amount:    string;
  nonce:     string;
  deadline:  string;
  signature: `0x${string}`;
  [key: string]: unknown;
}

// ─── Facilitator scheme ────────────────────────────────────────────────────────
export class AllowanceFacilitatorScheme {
  scheme     = "allowance";
  caipFamily = "eip155";

  // In-memory nonce registry — prevents replay within a process lifetime.
  private usedNonces = new Set<string>();

  constructor(private signer: {
    address: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract:             (args: any) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verifyTypedData:          (args: any) => Promise<boolean>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContract:            (args: any) => Promise<`0x${string}`>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitForTransactionReceipt:(args: any) => Promise<any>;
  }) {}

  getExtra(_network: string)   { return { facilitatorAddress: this.signer.address }; }
  getSigners(_network: string) { return [this.signer.address]; }

  async verify(paymentPayload: unknown, requirements: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p   = (paymentPayload as any).payload as AllowancePayload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = requirements as any;
    const extra   = req.extra ?? {};
    const asset   = req.asset   as `0x${string}`;
    const amount  = BigInt(req.amount);
    const chainId = parseInt((req.network as string).split(":")[1]);
    const facilitatorAddress = extra.facilitatorAddress as `0x${string}`;

    // Check deadline
    if (Date.now() / 1000 > parseInt(p.deadline)) {
      return { isValid: false, invalidReason: "payment deadline expired", payer: p.from };
    }

    // Check nonce not already used
    const nonceKey = `${chainId}:${p.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      return { isValid: false, invalidReason: "nonce already used", payer: p.from };
    }

    // Check balance
    const balance: bigint = await this.signer.readContract({
      address: asset, abi: BALANCE_ABI, functionName: "balanceOf", args: [p.from],
    });
    if (balance < amount) {
      return { isValid: false, invalidReason: "insufficient token balance", payer: p.from };
    }

    // Check allowance — the agent must have approved the facilitator
    const allowance: bigint = await this.signer.readContract({
      address: asset, abi: ALLOWANCE_ABI, functionName: "allowance",
      args: [p.from, this.signer.address],
    });
    if (allowance < amount) {
      return { isValid: false, invalidReason: "insufficient allowance — agent must approve facilitator first", payer: p.from };
    }

    // Verify EIP-712 signature
    const valid: boolean = await this.signer.verifyTypedData({
      address: p.from,
      domain: {
        name: "x402-allowance",
        version: "1",
        chainId,
        verifyingContract: facilitatorAddress,
      },
      types: PAYMENT_TYPES,
      primaryType: "Payment",
      message: {
        from:     p.from,
        to:       p.to,
        token:    p.token,
        amount,
        nonce:    BigInt(p.nonce),
        deadline: BigInt(p.deadline),
      },
      signature: p.signature,
    });

    if (!valid) {
      return { isValid: false, invalidReason: "invalid payment signature", payer: p.from };
    }

    return { isValid: true, payer: p.from };
  }

  async settle(paymentPayload: unknown, requirements: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p   = (paymentPayload as any).payload as AllowancePayload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = requirements as any;
    const asset  = req.asset  as `0x${string}`;
    const payTo  = req.payTo  as `0x${string}`;
    const amount = BigInt(req.amount);
    const chainId = parseInt((req.network as string).split(":")[1]);

    // Mark nonce used before submitting — prevents a second settle on the same auth
    const nonceKey = `${chainId}:${p.nonce}`;
    this.usedNonces.add(nonceKey);

    // transferFrom — the agent already approved the facilitator
    const hash = await this.signer.writeContract({
      address: asset,
      abi: TRANSFER_FROM_ABI,
      functionName: "transferFrom",
      args: [p.from, payTo, amount],
    });
    await this.signer.waitForTransactionReceipt({ hash });

    return {
      success: true,
      network: req.network as `${string}:${string}`,
      transaction: hash,
      payer: p.from,
    };
  }
}

// ─── Client scheme ─────────────────────────────────────────────────────────────
class AllowanceClientScheme {
  scheme = "allowance";

  constructor(private signer: {
    address: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (args: any) => Promise<`0x${string}`>;
  }) {}

  async createPaymentPayload(x402Version: number, requirements: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req   = requirements as any;
    const extra = req.extra ?? {};
    const asset            = req.asset             as `0x${string}`;
    const payTo            = req.payTo             as `0x${string}`;
    const facilitatorAddr  = extra.facilitatorAddress as `0x${string}`;
    const chainId          = parseInt((req.network as string).split(":")[1]);
    const amount           = BigInt(req.amount);
    const deadline         = BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds);

    // Random nonce — timestamp * large prime + random, collision-resistant for a prototype
    const nonce = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));

    const signature = await this.signer.signTypedData({
      domain: {
        name: "x402-allowance",
        version: "1",
        chainId,
        verifyingContract: facilitatorAddr,
      },
      types: PAYMENT_TYPES,
      primaryType: "Payment",
      message: {
        from:     this.signer.address,
        to:       payTo,
        token:    asset,
        amount,
        nonce,
        deadline,
      },
    });

    const payload: AllowancePayload = {
      from:      this.signer.address,
      to:        payTo,
      token:     asset,
      amount:    req.amount,
      nonce:     nonce.toString(),
      deadline:  deadline.toString(),
      signature,
    };

    return { x402Version, scheme: "allowance", network: req.network, payload };
  }
}

// ─── Registration helper ──────────────────────────────────────────────────────
export function registerAllowanceScheme(
  client: x402Client,
  options: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: any;
    network?: string;
  }
) {
  const scheme = new AllowanceClientScheme(options.signer);
  client.register((options.network ?? "eip155:*") as `${string}:${string}`, scheme);
}
