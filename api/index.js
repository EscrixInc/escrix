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
const { execSync, spawn } = require('child_process')

const app  = express()
app.use(express.json({ limit: '1mb' }))

// ── Deployed contract addresses ───────────────────────────────────────────────
const CONTRACTS = {
  baseSepolia: {
    escrow: '0x26031eF27DC648E18d53858197EfA03Bdd1Ba01a',
    deployedAt: '2026-09-15',
    chainId: 84532,
  },
  // baseMainnet: { escrow: '0x...', chainId: 8453 }  // add when mainnet deployed
}

const CONTRACT_ADDRESS = CONTRACTS.baseSepolia.escrow

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

  // Run Python verifier sandbox
  try {
    const verifyInput = JSON.stringify({ spec, result })
    const pyScript    = `
import json, sys
sys.path.insert(0, '/app/verifier')
from sandbox import verify_task
data   = json.loads(sys.stdin.read())
output = verify_task(data['spec'], data['result'])
print(json.dumps(output))
`
    const proc = require('child_process').spawnSync(
      'python3', ['-c', pyScript],
      { input: verifyInput, encoding: 'utf-8', timeout: 30000 }
    )

    if (proc.error) throw proc.error

    const outcome = JSON.parse(proc.stdout.trim())

    res.json({
      task_id,
      passed:      outcome.passed,
      note:        outcome.note,
      result_hash: outcome.result_hash,
      message:     outcome.passed
        ? '✅ Verification passed — call verify(task_id, true, note) on-chain'
        : '❌ Verification failed — call verify(task_id, false, note) on-chain',
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
