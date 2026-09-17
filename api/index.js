/**
 * Escrix API Server
 * -----------------
 * REST API for task posting, acceptance, result submission, and verification.
 * Bridges off-chain task specs / results with the on-chain EscrixEscrow contract.
 *
 * Base URL: https://api.escrix.dev/v1
 */

const express  = require('express')
const crypto   = require('crypto')
const { ethers } = require('ethers')
const { execSync, spawn } = require('child_process')

const app  = express()
app.use(express.json({ limit: '1mb' }))

// ── Deployed contract addresses ───────────────────────────────────────────────
const CONTRACTS = {
  baseSepolia: {
    escrow: '0x51F74f85dccD5F5048e2De44A6F4221Fc7c20574',
    usdc:   '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    deployedAt: '2026-09-16',
    chainId: 84532,
  },
  baseMainnet: {
    // escrow: '0x...',   // deploy when ready
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453,
  },
}

const CONTRACT_ADDRESS = CONTRACTS.baseSepolia.escrow
const NETWORK = CONTRACTS.baseSepolia

// ── Verifier node on-chain signer (optional — set VERIFIER_PRIVATE_KEY env var) ───────
// Without this, the API only does off-chain verification and returns the verdict.
// With it, the API automatically calls verify() on the smart contract.
const ESCROW_ABI = [
  'function verify(bytes32 taskId, bool passed, string calldata note) external',
  'function getTask(bytes32 taskId) external view returns (tuple(address poster, address executor, uint256 rewardUsdc, uint256 executorBond, bytes32 specHash, bytes32 resultHash, uint8 status, uint256 createdAt, uint256 acceptedAt, uint256 verifiedAt, string verifierNote))',
]

let verifierSigner = null
let escrowContract = null
if (process.env.VERIFIER_PRIVATE_KEY) {
  try {
    const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrl)
    verifierSigner  = new ethers.Wallet(process.env.VERIFIER_PRIVATE_KEY, provider)
    escrowContract  = new ethers.Contract(NETWORK.escrow, ESCROW_ABI, verifierSigner)
    console.log(`Verifier node active: ${verifierSigner.address}`)
  } catch (e) {
    console.warn('VERIFIER_PRIVATE_KEY set but wallet init failed:', e.message)
  }
}

// ── In-memory store (replace with DB in production) ───────────────────────────
const taskSpecs   = new Map()  // taskId → spec JSON
const taskResults = new Map()  // taskId → result JSON

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    chain: 'base-sepolia',
    contract: CONTRACT_ADDRESS,
  })
})

// ── POST /v1/specs — Store task specification off-chain ───────────────────────
/**
 * Called by task poster before createTask() on-chain.
 * Returns specHash to pass into the smart contract.
 *
 * Body: { type, function_signature, test_cases, allowed_imports?, reward_usdc }
 */
app.post('/v1/specs', (req, res) => {
  const spec = req.body
  if (!spec.type || !spec.test_cases) {
    return res.status(400).json({ error: 'type and test_cases are required' })
  }

  // Deterministic canonical JSON → hash (matches on-chain specHash)
  const canonical = JSON.stringify(spec, Object.keys(spec).sort())
  const specHash  = '0x' + crypto.createHash('sha3-256').update(canonical).digest('hex')

  taskSpecs.set(specHash, spec)

  res.json({
    spec_hash:  specHash,
    message:    'Use this spec_hash in createTask() on-chain',
    next_step:  'Call EscrixEscrow.createTask(spec_hash, reward_usdc) with your USDC approval',
  })
})

// ── GET /v1/specs/:specHash — Retrieve task spec ──────────────────────────────
app.get('/v1/specs/:specHash', (req, res) => {
  const spec = taskSpecs.get(req.params.specHash)
  if (!spec) return res.status(404).json({ error: 'Spec not found' })
  res.json(spec)
})

// ── POST /v1/results — Executor submits result ────────────────────────────────
/**
 * Called by executor after completing the task.
 * Returns resultHash to pass into submitResult() on-chain.
 *
 * Body: { task_id, implementation }
 */
app.post('/v1/results', (req, res) => {
  const { task_id, implementation } = req.body
  if (!task_id || !implementation) {
    return res.status(400).json({ error: 'task_id and implementation are required' })
  }

  const result    = { task_id, implementation, submitted_at: Date.now() }
  const canonical = JSON.stringify(result, Object.keys(result).sort())
  const resultHash = '0x' + crypto.createHash('sha3-256').update(canonical).digest('hex')

  taskResults.set(task_id, result)

  res.json({
    result_hash: resultHash,
    message:     'Use this result_hash in submitResult() on-chain',
    next_step:   'Call EscrixEscrow.submitResult(task_id, result_hash)',
  })
})

// ── POST /v1/verify — Trigger verification (Verifier Node only) ───────────────
/**
 * Called by authorized Escrix Verifier Node after on-chain submitResult().
 * Runs the sandbox and calls verify() on the smart contract.
 *
 * Body: { task_id, spec_hash, verifier_key }
 */
app.post('/v1/verify', async (req, res) => {
  const { task_id, spec_hash, verifier_key } = req.body

  // Simple API key auth (replace with on-chain verifier node signature in prod)
  if (verifier_key !== process.env.VERIFIER_KEY) {
    return res.status(401).json({ error: 'Unauthorized verifier' })
  }

  const spec   = taskSpecs.get(spec_hash)
  const result = taskResults.get(task_id)

  if (!spec)   return res.status(404).json({ error: 'Spec not found' })
  if (!result) return res.status(404).json({ error: 'Result not found' })

  // Run Python verifier sandbox (inline, no external file dependency)
  try {
    const verifyInput = JSON.stringify({ spec, result })
    const pyScript = `
import json, sys, hashlib, subprocess, tempfile, textwrap
from pathlib import Path

data   = json.loads(sys.stdin.read())
spec   = data['spec']
result = data['result']

implementation = result.get('implementation', '').strip()
test_cases     = spec.get('test_cases', [])
allowed_imports = spec.get('allowed_imports', [])

if not implementation:
    print(json.dumps({'passed': False, 'note': 'No implementation provided'}))
    sys.exit(0)

if not test_cases:
    print(json.dumps({'passed': False, 'note': 'No test cases in spec'}))
    sys.exit(0)

import_lines = '\\n'.join(f'import {m}' for m in allowed_imports)
test_lines   = '\\n'.join(f'    {t}' for t in test_cases)

test_script = f"""
{import_lines}
{implementation}
def run_tests():
{test_lines if test_lines else '    pass'}
run_tests()
print('__ESCRIX_PASS__')
"""

canonical    = json.dumps(result, sort_keys=True)
result_hash  = '0x' + hashlib.sha3_256(canonical.encode()).hexdigest()

try:
    proc = subprocess.run(['python3', '-c', test_script],
        capture_output=True, text=True, timeout=10)
    if '__ESCRIX_PASS__' in proc.stdout:
        print(json.dumps({'passed': True, 'note': 'All test cases passed', 'result_hash': result_hash}))
    else:
        detail = (proc.stderr or proc.stdout)[:400]
        print(json.dumps({'passed': False, 'note': f'Tests failed: {detail}', 'result_hash': result_hash}))
except Exception as e:
    print(json.dumps({'passed': False, 'note': str(e), 'result_hash': result_hash}))
`

    const proc = require('child_process').spawnSync(
      'python3', ['-c', pyScript],
      { input: verifyInput, encoding: 'utf-8', timeout: 30000 }
    )

    if (proc.error) throw proc.error
    if (!proc.stdout || !proc.stdout.trim()) {
      throw new Error(proc.stderr || 'Python verifier produced no output')
    }

    const outcome = JSON.parse(proc.stdout.trim())

    // Auto-call verify() on-chain if verifier node is configured
    let onchainTx = null
    if (escrowContract) {
      try {
        const tx = await escrowContract.verify(task_id, outcome.passed, outcome.note)
        await tx.wait()
        onchainTx = tx.hash
      } catch (err) {
        console.error('on-chain verify() failed:', err.message)
      }
    }

    res.json({
      task_id,
      passed:      outcome.passed,
      note:        outcome.note,
      result_hash: outcome.result_hash,
      onchain_tx:  onchainTx,
      message:     onchainTx
        ? (outcome.passed ? '✅ Verified on-chain — USDC released to executor' : '❌ Verified on-chain — USDC refunded, bond slashed')
        : (outcome.passed ? '✅ Passed — call verify(task_id, true, note) on-chain' : '❌ Failed — call verify(task_id, false, note) on-chain'),
    })

  } catch (err) {
    res.status(500).json({ error: 'Verification error', detail: err.message })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Escrix API running on port ${PORT}`)
  console.log(`Chain: Base Sepolia (testnet)`)
})

module.exports = app
