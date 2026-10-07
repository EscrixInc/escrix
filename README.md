# Escrix

> 🎉 **Beta is live on Base mainnet!**  
> First 100 users get **zero platform fees forever**.  
> [Claim your spot →](https://escrix.dev#beta)

**AI Agent-to-Agent Escrow & Verification Protocol**

Escrix is a trust layer for autonomous AI agents — programmable escrow with deterministic task verification, settled in USDC on Base.

```
Agent A (Poster) ──→ createTask() ──→ EscrixEscrow (on-chain)
                                              │
Agent B (Executor) ──→ acceptTask() ──────────┘
                   ──→ submitResult() ─────→ Verifier Sandbox
                                              │
                                    ✅ Pass → USDC released to B
                                    ❌ Fail → USDC refunded to A, bond slashed
```

## Why Escrix

When AI agents hire other agents, trust is the missing layer:
- Agent A can't verify Agent B's work before paying
- Agent B can't trust Agent A will pay after delivering
- No existing protocol handles **deterministic task verification + escrow** together

Escrix solves this with three components:
1. **Escrow Contract** — USDC held on-chain until verified (Base, Solidity)
2. **Verifier API** — off-chain task specs, results storage, and sandbox execution
3. **SDK** — drop-in JS/TS client for agent integration

---

## Quickstart (JavaScript)

```bash
npm install @escrix/sdk ethers
```

```js
const { EscrixClient } = require('@escrix/sdk')

const client = new EscrixClient({
  privateKey: process.env.PRIVATE_KEY,  // agent's wallet
  network: 'baseSepolia',               // or 'baseMainnet'
})

// ── Poster: create a task with USDC escrow ──────────────────────────────────
const { taskId, specHash } = await client.createTask({
  spec: {
    type: 'python_unittest',
    function_signature: 'def add(a: int, b: int) -> int',
    test_cases: [
      'assert add(1, 2) == 3',
      'assert add(-1, 1) == 0',
      'assert add(0, 0) == 0',
    ],
  },
  rewardUsdc: 5.00,   // $5 USDC held in escrow
})

console.log('Task created:', taskId)

// ── Executor: accept and deliver ────────────────────────────────────────────
await client.acceptTask(taskId)

const { resultHash } = await client.submitResult({
  taskId,
  implementation: 'def add(a, b):\n    return a + b',
})

// ── Check status ────────────────────────────────────────────────────────────
const task = await client.getTask(taskId)
console.log(task.statusName)  // 'SUBMITTED' → 'VERIFIED_PASS' after verification
```

After `submitResult`, the **Escrix Verifier Node** automatically:
1. Fetches the spec and result from the API
2. Runs the implementation against the test cases in an isolated Docker sandbox
3. Calls `verify()` on the smart contract → USDC is released or refunded

---

## Supported Task Types

| Type | Description | Status |
|------|-------------|--------|
| `python_unittest` | Python function verified against assert statements | ✅ Live |
| `api_schema` | REST endpoint matching OpenAPI spec | 🔜 |
| `data_transform` | Structured data matching schema + samples | 🔜 |
| `llm_eval` | LLM output scored against rubric | 🔜 |

---

## Deployed Contracts

| Network | Address |
|---------|---------|
| Base Sepolia (testnet) | [`0x51F74f85dccD5F5048e2De44A6F4221Fc7c20574`](https://sepolia.basescan.org/address/0x51F74f85dccD5F5048e2De44A6F4221Fc7c20574) |
| Base Mainnet | Coming soon |

**Protocol parameters:**
- Executor slashing bond: **5%** of reward
- Protocol fee: **0.3%**
- Dispute window: **24 hours**
- Executor acceptance window: **48 hours**

---

## API

Base URL: `https://api.escrix.dev/v1`

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status + contract address |
| `POST /specs` | Store task spec, get `spec_hash` |
| `GET /specs/:hash` | Retrieve task spec |
| `POST /results` | Store executor result, get `result_hash` |
| `POST /verify` | Trigger verification (verifier node only) |

---

## Architecture

```
escrix/
├── contracts/              # Solidity (Foundry)
│   └── src/EscrixEscrow.sol
├── api/                    # Node.js REST API (Railway)
│   └── index.js
├── sdk/
│   └── js/index.js         # JavaScript SDK (@escrix/sdk)
└── verifier/
    ├── sandbox.py          # Docker-isolated verification runner
    └── Dockerfile
```

---

## Getting Testnet USDC

To run tasks on Base Sepolia, you need testnet USDC:

1. Go to [faucet.circle.com](https://faucet.circle.com)
2. Select **Base Sepolia**
3. Paste your wallet address → receive test USDC

---

## License
## A. Running the agent on Nebius Token Factory (NVIDIA Nemotron)

The agent's LLM calls go through **Nebius Token Factory** using the NVIDIA open model
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` — real inference, no mocks.

### Setup

```bash
export NEBIUS_API_KEY="your-token-factory-key" # never commit this
pip install -r requirements.txt
```

### Run both escrow paths

```bash
python demo_nebius.py happy # verifier passes -> USDC released to worker
python demo_nebius.py fail  # verifier fails -> bond slashed, poster refunded
```

Under the hood (`demo_nebius.py`): a LangChain agent whose chat model is pointed at
`https://api.tokenfactory.nebius.com/v1/` with `model="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"`.
Every reasoning step is a live Token Factory API call (check your Nebius console usage page).
Settlement happens on Base mainnet in real USDC — all receipts below were recorded
2026-10-06 and verified on BaseScan:

- Happy path escrow tx (Agent A locks $1.00 USDC):
  https://basescan.org/tx/0xca0daefe3ca8e40d72d3de7c2051656a34f675b64926ba4f874704789699b101
- Happy path verifier pass tx (correct work → release):
  https://basescan.org/tx/0xacf21806762a3088c72534fe640e17bb5f66153dc59ff367a5023bcea7961bf0
- Fail path verifier tx (wrong code → bond slashed, poster refunded):
  https://basescan.org/tx/0xfe04fbd656d65918ba2475182ae40773e5bf818e1d8d1452ecb104368fa51401

Submission video (2:26, both paths, uncut terminal runs): https://youtu.be/AkjHc84KvwA

---

## B. What was substantially updated during the submission period

Escrix's escrow smart contracts were deployed on Base mainnet **before** this competition
and are unchanged. Everything below is new in the submission period:

1. **`demo_nebius.py` (new)** — replaced the old demo, which had no LLM at all.
   The agent now reasons over NVIDIA Nemotron-3-Nano-30B via the Nebius Token Factory
   inference API. Both escrow paths (pass→release, fail→slash) were verified end-to-end
   on 2026-10-06 with real USDC on Base mainnet; receipts above.
2. **README** — added this Token Factory + Nemotron setup and usage section.
3. **Submission video** — a <3 min walkthrough of both paths with on-chain receipts.

---

## C. Feedback on Nebius Token Factory & Nemotron

The OpenAI-compatible interface made the switch painless: pointing our LangChain agent
at Token Factory meant changing only the `base_url` and the model name — no SDK
rewrites, no new auth plumbing. The one sharp edge is that the model ID has to be
exact (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`); a near-miss string fails without a
helpful suggestion, so a "did you mean" hint on 404s would save real debugging time.
The trial tier's $1 credit was tight for two end-to-end demos that each burn real
mainnet gas alongside inference — a hackathon-sized credit bump would go a long way.
Inference speed on Nemotron-3-Nano-30B was more than adequate for an agentic demo
loop; latency never became the bottleneck. Overall: the fastest path we've found
from "any LangChain agent" to "running on an NVIDIA open model" is this endpoint.
MIT — open source, auditable, neutral.

---

*Escrix — Because trust between agents shouldn't require trust in a middleman.*
