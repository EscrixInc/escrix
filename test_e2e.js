/**
 * Escrix End-to-End Test — Two-wallet flow
 * Poster creates task, Executor accepts + submits, Verifier verifies on-chain
 *
 * Usage:
 *   POSTER_KEY=0x... EXECUTOR_KEY=0x... VERIFIER_KEY=xxx node test_e2e.js
 */

const { EscrixClient } = require('./sdk/js/index.js')
const https = require('https')

const POSTER_KEY   = process.env.POSTER_KEY
const EXECUTOR_KEY = process.env.EXECUTOR_KEY
const API_URL      = process.env.API_URL || 'https://escrix-production.up.railway.app/v1'
const VERIFIER_KEY = process.env.VERIFIER_KEY || 'test-key'

if (!POSTER_KEY || !EXECUTOR_KEY) {
  console.error('ERROR: Set POSTER_KEY and EXECUTOR_KEY env vars')
  process.exit(1)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve(JSON.parse(d)))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function main() {
  console.log('\n🚀 Escrix End-to-End Test — Base Sepolia\n')

  const poster   = new EscrixClient({ privateKey: POSTER_KEY,   network: 'baseSepolia', apiUrl: API_URL })
  const executor = new EscrixClient({ privateKey: EXECUTOR_KEY, network: 'baseSepolia', apiUrl: API_URL })

  // ── Step 1: Check balances ────────────────────────────────────────────────
  const posterBal   = await poster.usdcBalance()
  const executorBal = await executor.usdcBalance()
  console.log(`💰 Poster USDC:   $${posterBal.toFixed(2)}`)
  console.log(`💰 Executor USDC: $${executorBal.toFixed(2)}`)
  if (posterBal < 1.00) { console.error('❌ Poster needs $1+ USDC'); process.exit(1) }
  if (executorBal < 0.05) { console.error('❌ Executor needs $0.05+ USDC for bond'); process.exit(1) }

  // ── Step 2: Create task ───────────────────────────────────────────────────
  console.log('\n📋 Step 1: Poster creates task ($1 USDC reward)...')
  const { taskId, specHash, txHash: createTx } = await poster.createTask({
    spec: {
      type: 'python_unittest',
      function_signature: 'def add(a: int, b: int) -> int',
      test_cases: [
        'assert add(1, 2) == 3',
        'assert add(-1, 1) == 0',
        'assert add(0, 0) == 0',
      ],
    },
    rewardUsdc: 1.00,
  })
  console.log(`✅ Task created: ${taskId}`)
  console.log(`   tx: https://sepolia.basescan.org/tx/${createTx}`)

  // ── Step 3: Accept task ───────────────────────────────────────────────────
  console.log('\n🤝 Step 2: Executor accepts task (deposits bond)...')
  const { txHash: acceptTx } = await executor.acceptTask(taskId)
  console.log(`✅ Accepted!`)
  console.log(`   tx: https://sepolia.basescan.org/tx/${acceptTx}`)

  // ── Step 4: Submit result ──────────────────────────────────────────────────
  console.log('\n📤 Step 3: Executor submits result...')
  const { resultHash, txHash: submitTx } = await executor.submitResult({
    taskId,
    implementation: 'def add(a, b):\n    return a + b',
  })
  console.log(`✅ Result submitted!`)
  console.log(`   resultHash: ${resultHash}`)
  console.log(`   tx: https://sepolia.basescan.org/tx/${submitTx}`)

  // ── Step 5: Verify ────────────────────────────────────────────────────────
  console.log('\n🔍 Step 4: Triggering verification...')
  const verifyRes = await post(`${API_URL}/verify`, {
    task_id: taskId,
    spec_hash: specHash,
    verifier_key: VERIFIER_KEY,
  })
  console.log(`   passed: ${verifyRes.passed}`)
  console.log(`   note:   ${verifyRes.note}`)
  if (verifyRes.onchain_tx) {
    console.log(`   on-chain: https://sepolia.basescan.org/tx/${verifyRes.onchain_tx}`)
  }

  // ── Step 6: Final status ──────────────────────────────────────────────────
  await sleep(3000)
  console.log('\n📊 Step 5: Final task status...')
  const task = await poster.getTask(taskId)
  console.log(`   status: ${task.statusName}`)
  console.log(`   note:   ${task.verifierNote}`)

  const fp = await poster.usdcBalance()
  const fe = await executor.usdcBalance()
  console.log(`\n💰 Poster final:   $${fp.toFixed(2)} (paid $1 reward)`)
  console.log(`💰 Executor final: $${fe.toFixed(2)} (received $1 reward + bond back)`)

  if (task.statusName === 'VERIFIED_PASS') {
    console.log('\n🎉 END-TO-END TEST PASSED!')
  } else {
    console.log(`\n⚠️  Unexpected status: ${task.statusName}`)
  }
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message)
  process.exit(1)
})
