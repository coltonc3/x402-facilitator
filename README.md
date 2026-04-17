# x402 Facilitator Prototype

A working prototype of the [x402 payment protocol](https://docs.x402.org) on Base Sepolia, including a custom facilitator with access control and multi-token payment support.

## What's in here

| File | Role |
|------|------|
| `src/server.ts` | Seller — Express API with paid endpoints (`/data`, `/data-usdt`) |
| `src/facilitator.ts` | Facilitator — handles `/verify` and `/settle` on behalf of the server |
| `src/agent.ts` | Buyer — makes requests and auto-pays 402 responses |
| `src/approve.ts` | One-time setup — approves the facilitator to spend USDT on behalf of an agent |
| `src/schemes/allowance.ts` | Custom x402 scheme for tokens without EIP-3009 (e.g. USDT) |
| `src/config.ts` | Shared config, reads from `.env` |

## How the three roles interact

```
agent                    server                  facilitator          blockchain
  |                        |                         |                    |
  |-- GET /data ---------->|                         |                    |
  |<-- 402 (pay $0.0001) --|                         |                    |
  |                        |                         |                    |
  | [signs payment auth]   |                         |                    |
  |                        |                         |                    |
  |-- GET /data + sig ---->|                         |                    |
  |                   POST /verify ----------------->|                    |
  |                   POST /settle ----------------->|                    |
  |                        |                    [submit tx]-------------->|
  |                        |                    [wait for receipt] <------|
  |                   <-- { success, txHash } -------|                    |
  |<-- 200 response -------|                         |                    |
```

The **server** never touches the blockchain directly. The **facilitator** holds the signing key and submits transactions. The **agent** signs a payment authorization and attaches it to the retry request.

## Payment schemes

| Scheme | Token | How it works | Agent needs ETH? |
|--------|-------|-------------|-----------------|
| `exact` (EIP-3009) | USDC | Agent signs a `transferWithAuthorization`. Facilitator submits one tx. | No |
| `allowance` | USDT (or any ERC-20) | Agent approves facilitator once on-chain, then signs a typed payment message per-request. Facilitator calls `transferFrom`. | Once (for `approve`) |

The `exact` scheme only works with tokens that implement EIP-3009 — in practice USDC and EURC. The `allowance` scheme works with any ERC-20, including USDT.

## Setup

```bash
npm install
```

Copy `.env` and fill in your own values (or use the existing testnet wallets):

```
PRIVATE_KEY=0x...              # agent1 wallet private key
PAY_TO_ADDRESS=0x...           # address that receives payments (server's wallet)
SERVER_PRIVATE_KEY=0x...       # facilitator wallet private key (pays gas)
RPC_URL=https://sepolia.base.org
API_SERVER_PORT=4021
FACILITATOR_PORT=4022
AGENT2_PRIVATE_KEY=0x...       # agent2 wallet private key
AGENT2_ADDRESS=0x...
# USDT_ADDRESS=0x...           # optional — falls back to USDC if unset
```

The **facilitator wallet** needs ETH for gas. Agent wallets need USDC (and/or USDT) but no ETH — the facilitator pays all gas.

- ETH faucet: https://faucet.quicknode.com/base/sepolia
- USDC faucet: https://faucet.circle.com (select Base Sepolia, 20 USDC per request)

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run ui` | **Demo dashboard** — all three services in one process, open `http://localhost:4023` |
| `npm run dev` | Start custom facilitator + server together |
| `npm run dev:whitelist` | Same, but with agent2 whitelisted and agent1 blacklisted |
| `npm run server` | Server only, using local facilitator on `:4022` |
| `npm run server:coinbase` | Server only, using Coinbase's testnet facilitator |
| `npm run facilitator` | Custom facilitator only, no access control |
| `npm run facilitator:whitelist` | Custom facilitator with agent2 whitelisted, agent1 blacklisted |
| `npm run agent1` | Agent1 makes a USDC payment to `TARGET_URL` (default: `/data`) |
| `npm run agent2` | Agent2 makes a USDC payment to `TARGET_URL` |
| `npm run agent1:usdt` | Agent1 makes a USDT payment to `/data-usdt` |
| `npm run agent2:usdt` | Agent2 makes a USDT payment to `/data-usdt` |
| `npm run approve` | One-time: approve the facilitator to spend USDT on behalf of agent1 |

## Demo dashboard

The easiest way to see the full flow. Runs server + facilitator + dashboard in one process and streams each step to a three-panel UI in real time.

```bash
npm run ui
# open http://localhost:4023
```

Three buttons:

- **▶ Run Payment** — happy path with USDC (EIP-3009). Watch the agent sign, server verify+settle, facilitator submit the on-chain tx, agent receive 200.
- **$ Run USDT** — same flow but with USDT via the allowance scheme. Auto-approves the facilitator on first run if needed, then signs a per-request payment authorization.
- **✗ Run Blocked** — agent1 blacklisted at the facilitator. Shows the ACL denial propagating back through server to agent.

Wallet balances refresh after each run.

> Note: `npm run ui` starts its own server and facilitator on `:4021` and `:4022`. Stop any existing `npm run dev` or `npm run server` processes first.

## USDT payments (allowance scheme)

The USDT endpoint uses a custom `allowance` scheme. Agents must approve the facilitator to spend tokens before the first payment. The `$ Run USDT` dashboard button handles this automatically. For terminal use:

```bash
# Terminal 1
npm run dev

# Terminal 2 — one time per agent wallet
npm run approve

# Terminal 3
npm run agent1:usdt
```

The approval is `MaxUint256` and persists on-chain — you only need to run it once per agent per token.

> On Base Sepolia testnet there is no official USDT deployment with a faucet. `USDT_ADDRESS` defaults to the USDC contract so the allowance scheme can be tested end-to-end. Set `USDT_ADDRESS` in `.env` to use a real USDT contract when one is available.

## Running it

### Quickest — everything at once

```bash
# Terminal 1
npm run dev

# Terminal 2
TARGET_URL=http://localhost:4021/data npm run agent1
```

### Against Coinbase's facilitator instead

```bash
# Terminal 1
npm run server:coinbase

# Terminal 2
TARGET_URL=http://localhost:4021/data npm run agent1
```

## Access control

The custom facilitator supports blacklists and whitelists via environment variables.

### Whitelist (only named addresses can pay)

```bash
export WHITELIST_ENABLED=true
export WHITELIST=0xDD90f58b3A6c7AA2386F620cc2280e9183Bbbf76
npm run facilitator
```

Or in one command:

```bash
npm run dev:whitelist
```

### Blacklist (named addresses are blocked, everyone else is allowed)

```bash
export BLACKLIST=0xB655E8450EF9D07E5B555CF19B7915329B53dbcA
npm run facilitator
```

Multiple addresses are comma-separated:

```bash
export WHITELIST=0xADDR1,0xADDR2,0xADDR3
```

## Wallets

| Name | Address |
|------|---------|
| Agent1 | `0xB655E8450EF9D07E5B555CF19B7915329B53dbcA` |
| Agent2 | `0xDD90f58b3A6c7AA2386F620cc2280e9183Bbbf76` |
| Facilitator (gas) | `0xA49CfEE75D6a0c79e7Fca4FeFE3606038f05B10f` |
| Server (pay-to) | `0xB22672F7cCb921C0A1C673C204013cad71A89774` |

## Endpoints

| Service | Endpoint | Description |
|---------|----------|-------------|
| Server | `GET /data` | Paid endpoint — $0.0001 USDC (exact/EIP-3009 scheme) |
| Server | `GET /data-usdt` | Paid endpoint — $0.0001 USDT (allowance scheme) |
| Server | `GET /health` | Health check, free |
| Facilitator | `POST /verify` | Validate a payment payload |
| Facilitator | `POST /settle` | Settle a payment on-chain |
| Facilitator | `GET /supported` | List supported payment schemes |
| Facilitator | `GET /health` | Health check, free |

## Network

Everything runs on **Base Sepolia** (testnet), CAIP-2: `eip155:84532`.

USDC contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

Coinbase testnet facilitator: `https://x402.org/facilitator`
