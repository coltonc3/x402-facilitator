# Decision Log

Architectural and design decisions made in this project, with reasoning. Updated every time a significant decision is made.

---

## 2026-04-16 — Remove EIP-2612 permit scheme as redundant in this prototype

**Context:** After implementing both EIP-2612 permit and the allowance scheme, the permit scheme served no unique purpose within this prototype's scope.

**Decision:** Remove `src/schemes/eip2612.ts`, the `/data-permit` endpoint, and all related wiring.

**Reasoning:** The prototype uses USDC (covered by exact/EIP-3009) and USDT (covered by allowance). EIP-2612 permit fills the gap for tokens that have permit but not EIP-3009 (DAI, UNI, etc.) — but none of those tokens exist on Base Sepolia testnet with a faucet. Keeping the scheme added complexity (three schemes, extra endpoints, extra button in the dashboard) without enabling any new demo scenario. Exact + allowance covers the full range of what can actually be demonstrated here.

**Note:** EIP-2612 is still the right choice in production for tokens like DAI/UNI where you want gasless payments without a pre-approval. The decision to remove is prototype-scope, not a statement on the scheme's value.

---

## 2026-04-16 — Use EIP-2612 permit over EIP-3009 for multi-token support (later reversed)

**Context:** We tried to add a USDT-only endpoint. USDT doesn't implement EIP-3009 (`transferWithAuthorization`), which the built-in x402 "exact" scheme relies on.

**Decision:** Build a custom EIP-2612 permit-based scheme (`src/schemes/eip2612.ts`) as a second payment path alongside the existing exact scheme.

**Reasoning:** EIP-2612 is implemented by a much wider set of tokens (DAI, UNI, any OpenZeppelin ERC-20 since ~2021), while EIP-3009 is essentially Circle-only (USDC, EURC). The tradeoff is two on-chain transactions (permit + transferFrom) instead of one, but the agent still signs once off-chain and never pays gas.

**Alternatives considered:**
- Pre-session `approve()` — ruled out at the time because it requires agent ETH upfront, but later adopted for the allowance scheme
- Sticking with EIP-3009 only — limits token support too severely

---

## 2026-04-16 — Use allowance scheme (approve + transferFrom) for USDT

**Context:** Even with EIP-2612, USDT cannot be supported. Tether's contract implements neither EIP-3009 nor EIP-2612, and Tether has no plans to add permit support.

**Decision:** Build a third scheme (`src/schemes/allowance.ts`) where the agent calls `approve(facilitator, amount)` once on-chain, then signs a typed payment authorization per-request. Facilitator calls `transferFrom` directly.

**Reasoning:** This is the only path for tokens that don't support gasless authorization. The agent pays ETH once for the approval; all subsequent payments are gasless per-request (just a signed message). Per-payment cost is also lower than EIP-2612 (1 tx vs 2).

**Alternatives considered:**
- Requiring agents to submit `transferFrom` themselves — defeats the purpose of x402 (agent shouldn't need gas per payment)
- Wrapping USDT in a permit-compatible contract — adds a dependency on a wrapper token that users would have to acquire

---

## 2026-04-16 — In-memory nonce tracking for allowance scheme replay protection

**Context:** The allowance scheme needs replay protection — without it, a valid signed payment authorization could be submitted multiple times by the facilitator.

**Decision:** Track used nonces in a `Set<string>` on the `AllowanceFacilitatorScheme` instance (in-memory, resets on process restart).

**Reasoning:** Sufficient for a prototype. The nonce is a random 64-bit value combined with a deadline, so collisions are negligible. A restarted facilitator can only replay within the deadline window of inflight payments.

**Alternatives considered:**
- On-chain nonce registry contract — correct for production, but adds deploy overhead and gas cost per-payment
- Persistent store (Redis, SQLite) — reasonable next step before production

---

## 2026-04-16 — USDT_ADDRESS falls back to USDC on testnet

**Context:** There is no official Tether USDT deployment on Base Sepolia with a public faucet. Random mock contracts exist but are unreliable.

**Decision:** `USDT_ADDRESS` env var defaults to the USDC contract address if unset, so the allowance scheme can be tested end-to-end on testnet without real USDT.

**Reasoning:** The allowance scheme's code path is the important thing to verify. The token address is a configuration detail — swapping in the real USDT address in production requires no code changes.

---

## 2026-04-16 — facilitatorAddress passed via requirements.extra

**Context:** EIP-2612 permit and the allowance scheme both require the agent to know the facilitator's address before signing (it's the `spender` in permit and the `verifyingContract` in the allowance EIP-712 domain).

**Decision:** Server includes `extra.facilitatorAddress` in the payment requirements advertised in the 402 response. The facilitator's `getExtra()` also returns it for the `/supported` endpoint.

**Reasoning:** The server already knows which facilitator it's using (it's configured via `FACILITATOR_URL`). Passing the address through `extra` avoids a separate round-trip from the agent to the facilitator, and keeps the x402 contract — server tells agent everything it needs to sign — intact.

---

## 2026-04-16 — Auto-approve in UI dashboard before allowance demo

**Context:** The `$ Run USDT` button in the dashboard needs to work end-to-end without the user manually running `npm run approve` first.

**Decision:** The `/demo?usdt=true` handler checks the agent's allowance on-chain before running the demo. If insufficient, it calls `approve(facilitator, MaxUint256)` inline, waits for confirmation, then proceeds.

**Reasoning:** Demo usability. Requiring a manual setup step before a demo button works is a poor experience, especially when the approve logic is straightforward. The dashboard is a demo tool, not a production interface, so the inline approve is appropriate here.

**Note:** `npm run approve` still exists as the non-UI path for agents running from the terminal.

---

## 2026-04-16 — Explicit payment flow in server.ts (no middleware)

**Context:** The `@x402/express` package provides `paymentMiddlewareFromConfig` that abstracts the full verify/settle cycle into one line.

**Decision:** Write the payment flow explicitly in each route handler (decode → verify → settle → respond) rather than using the middleware.

**Reasoning:** Educational clarity. Each step is visible and individually logged. A comment in the file directs readers to the middleware abstraction if they want it.

---

## 2026-04-16 — Separate facilitator and server wallets

**Context:** Initially the facilitator's signing wallet (`SERVER_PRIVATE_KEY`) was being used as both the gas payer and the USDC recipient.

**Decision:** Two distinct wallets: the facilitator wallet (`0xA49C…`) holds ETH and submits transactions; the server wallet (`0xB226…`) receives USDC payments.

**Reasoning:** Separation of concerns and security. The facilitator wallet needs ETH for gas but shouldn't accumulate the payment funds. If the facilitator key is compromised, the payment funds in the server wallet are not at risk.

---

## 2026-04-16 — Local facilitator as default (not Coinbase's)

**Context:** The server originally defaulted to `https://x402.org/facilitator` (Coinbase's testnet facilitator).

**Decision:** Default `FACILITATOR_URL` to `http://localhost:4022`. Coinbase's facilitator is opt-in via `npm run server:coinbase`.

**Reasoning:** The custom facilitator is the subject of this prototype — access control, custom schemes, SSE hooks. Defaulting to Coinbase's bypasses all of that. The local facilitator is always running when `npm run dev` or `npm run ui` is used.

---

## 2026-04-16 — Single-process UI (ui.ts runs all three servers)

**Context:** Demonstrating the full payment flow requires a facilitator, a server, and an agent — normally three separate processes.

**Decision:** `src/ui.ts` starts the facilitator (`:4022`), server (`:4021`), and dashboard (`:4023`) in one process. The agent runs in-process per demo invocation.

**Reasoning:** Demo simplicity. One command (`npm run ui`) shows the full flow with no coordination between terminals. The in-process agent allows SSE events to be emitted at each step of its decision-making, which would be impossible if the agent were a separate process.

**Tradeoff:** The in-process agent can't be swapped for a real external agent without changes. The separate `npm run agent1` scripts exist for that use case.

---

## 2026-04-16 — SSE for real-time dashboard

**Context:** The dashboard needs to show each step of the payment flow as it happens.

**Decision:** Server-Sent Events (SSE) over a single `/events` endpoint. Each entity (agent, server, facilitator) emits typed events that the browser renders in its panel.

**Reasoning:** SSE is unidirectional (server → client), which is all we need. Simpler than WebSockets for this use case — no client-to-server messages, no connection management overhead, native `EventSource` in the browser with no dependencies.

---

## 2026-04-16 — EIP-712 domain uses facilitator address as verifyingContract in allowance scheme

**Context:** The allowance scheme needs an EIP-712 domain for the payment authorization signature. The domain's `verifyingContract` must be something meaningful that binds the signature to a specific context.

**Decision:** Use `verifyingContract: facilitatorAddress` with `name: "x402-allowance", version: "1"`.

**Reasoning:** Binding to the facilitator address means a signature issued for facilitator A cannot be replayed against facilitator B. This is analogous to how EIP-2612 uses the token contract as `verifyingContract` — it scopes the signature to a specific contract interaction. Since there's no on-chain contract involved in the authorization itself, the facilitator address is the natural anchor.
