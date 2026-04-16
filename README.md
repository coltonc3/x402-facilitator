# x402 Facilitator Prototype

A working prototype of the [x402 payment protocol](https://docs.x402.org) on Base Sepolia, including a custom facilitator with access control.

## What's in here

| File | Role |
|------|------|
| `src/server.ts` | Seller — Express API with a paid `/data` endpoint |
| `src/facilitator.ts` | Facilitator — handles `/verify` and `/settle` on behalf of the server |
| `src/agent.ts` | Buyer — makes requests and auto-pays 402 responses |
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

## Setup

```bash
npm install
```

Copy `.env` and fill in your own values (or use the existing testnet wallets):

```
PRIVATE_KEY=0x...              # agent1 wallet private key
PAY_TO_ADDRESS=0x...           # address that receives payments (server's wallet)
RPC_URL=https://sepolia.base.org
API_SERVER_PORT=4021
FACILITATOR_PORT=4022
COINBASE_FACILITATOR_URL=https://x402.org/facilitator
AGENT2_PRIVATE_KEY=0x...       # agent2 wallet private key
AGENT2_ADDRESS=0x...
```

Both wallets need ETH (gas) and USDC on Base Sepolia:
- ETH faucet: https://faucet.quicknode.com/base/sepolia
- USDC faucet: https://faucet.circle.com (select Base Sepolia, 20 USDC per request)

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start custom facilitator + server together (facilitator first, server waits) |
| `npm run dev:whitelist` | Same, but with agent2 whitelisted and agent1 blacklisted |
| `npm run server` | Server only, using local facilitator on `:4022` (default) |
| `npm run server:coinbase` | Server only, using Coinbase's testnet facilitator |
| `npm run facilitator` | Custom facilitator only, no access control |
| `npm run facilitator:whitelist` | Custom facilitator with agent2 whitelisted, agent1 blacklisted |
| `npm run agent1` | Agent1 wallet makes a paid request to `TARGET_URL` |
| `npm run agent2` | Agent2 wallet makes a paid request to `TARGET_URL` |

## Running it

### Quickest — everything at once

```bash
# Terminal 1
npm run dev

# Terminal 2
TARGET_URL=http://localhost:4021/data npm run agent1
```

### Manually (three terminals)

```bash
# Terminal 1 — facilitator
npm run facilitator

# Terminal 2 — server (wait for facilitator to show "Ready" first)
npm run server

# Terminal 3 — agent
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
# Terminal 1
export WHITELIST_ENABLED=true
export WHITELIST=0xDD90f58b3A6c7AA2386F620cc2280e9183Bbbf76
npm run facilitator

# Terminal 2
npm run server:my

# Terminal 3 — agent1 is blocked, agent2 gets through
TARGET_URL=http://localhost:4021/data npm run agent1   # 402, denied
TARGET_URL=http://localhost:4021/data npm run agent2   # 200, paid
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

### Both at once

```bash
export WHITELIST_ENABLED=true
export WHITELIST=0xDD90f58b3A6c7AA2386F620cc2280e9183Bbbf76
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
| Server (pay-to) | `0xA49CfEE75D6a0c79e7Fca4FeFE3606038f05B10f` |

## Endpoints

| Service | Endpoint | Description |
|---------|----------|-------------|
| Server | `GET /data` | Paid endpoint — $0.0001 USDC per request |
| Server | `GET /health` | Health check, free |
| Facilitator | `POST /verify` | Validate a payment payload |
| Facilitator | `POST /settle` | Settle a payment on-chain |
| Facilitator | `GET /supported` | List supported payment schemes |
| Facilitator | `GET /health` | Health check, free |

## Network

Everything runs on **Base Sepolia** (testnet), CAIP-2: `eip155:84532`.

USDC contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

Coinbase testnet facilitator: `https://x402.org/facilitator`
