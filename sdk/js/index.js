/**
 * Escrix SDK — JavaScript/TypeScript
 * AI Agent-to-Agent programmable escrow & task verification protocol
 *
 * Usage:
 *   const { EscrixClient } = require('@escrix/sdk')
 *   const client = new EscrixClient({ rpcUrl, privateKey })
 *   const { taskId } = await client.createTask({ spec, rewardUsdc: 5.00 })
 *
 * https://escrix.dev
 */

const { ethers } = require('ethers')
const https = require('https')
const http  = require('http')

// ── Contract addresses ────────────────────────────────────────────────────────

const CONTRACTS = {
  baseSepolia: {
    escrow:  '0x51F74f85dccD5F5048e2De44A6F4221Fc7c20574',
    usdc:    '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    chainId: 84532,
    rpcUrl:  'https://sepolia.base.org',
  },
  baseMainnet: {
    // escrow:  '0x...',  // coming soon
    usdc:    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453,
    rpcUrl:  'https://mainnet.base.org',
  },
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ESCROW_ABI = [
  'function createTask(bytes32 specHash, uint256 rewardUsdc) external returns (bytes32)',
  'function acceptTask(bytes32 taskId) external',
  'function submitResult(bytes32 taskId, bytes32 resultHash) external',
  'function raiseDispute(bytes32 taskId) external',
  'function cancelTask(bytes32 taskId) external',
  'function getTask(bytes32 taskId) external view returns (tuple(address poster, address executor, uint256 rewardUsdc, uint256 executorBond, bytes32 specHash, bytes32 resultHash, uint8 status, uint256 createdAt, uint256 acceptedAt, uint256 verifiedAt, string verifierNote))',
  'function taskCount() external view returns (uint256)',
  'event TaskCreated(bytes32 indexed taskId, address poster, uint256 rewardUsdc, bytes32 specHash)',
  'event TaskAccepted(bytes32 indexed taskId, address executor, uint256 bond)',
  'event TaskVerified(bytes32 indexed taskId, bool passed, string note)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
]

// ── Task status enum (mirrors Solidity) ───────────────────────────────────────

const TaskStatus = {
  0: 'OPEN',
  1: 'ACCEPTED',
  2: 'SUBMITTED',
  3: 'VERIFIED_PASS',
  4: 'VERIFIED_FAIL',
  5: 'DISPUTED',
  6: 'CANCELLED',
}

// ── EscrixClient ──────────────────────────────────────────────────────────────

class EscrixClient {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey   Signer's private key (0x...)
   * @param {string} [opts.network]    'baseSepolia' (default) | 'baseMainnet'
   * @param {string} [opts.rpcUrl]     Override RPC URL
   * @param {string} [opts.apiUrl]     Escrix API base URL (default: https://api.escrix.dev/v1)
   */
  constructor({ privateKey, network = 'baseSepolia', rpcUrl, apiUrl }) {
    const net = CONTRACTS[network]
    if (!net) throw new Error(`Unknown network: ${network}`)
    if (!net.escrow) throw new Error(`Escrix not yet deployed on ${network}`)

    this._apiUrl  = (apiUrl || 'https://api.escrix.dev/v1').replace(/\/$/, '')
    this._network = net

    const provider = new ethers.JsonRpcProvider(rpcUrl || net.rpcUrl)
    this._signer   = new ethers.Wallet(privateKey, provider)
    this._escrow   = new ethers.Contract(net.escrow, ESCROW_ABI, this._signer)
    this._usdc     = new ethers.Contract(net.usdc,   ERC20_ABI,  this._signer)
  }

  // ── Poster actions ──────────────────────────────────────────────────────────

  /**
   * Post a task: store spec off-chain, approve USDC, and call createTask().
   *
   * @param {object} opts
   * @param {object} opts.spec          Task specification (type, test_cases, etc.)
   * @param {number} opts.rewardUsdc    USDC reward in dollars (e.g. 5.00)
   * @returns {{ taskId, specHash, txHash }}
   */
  async createTask({ spec, rewardUsdc }) {
    // 1. Store spec off-chain, get specHash
    const { spec_hash: specHash } = await this._apiPost('/specs', spec)

    // 2. Convert to USDC units (6 decimals)
    const rewardAmount = BigInt(Math.round(rewardUsdc * 1e6))

    // 3. Approve USDC spend
    const allowance = await this._usdc.allowance(this._signer.address, this._network.escrow)
    if (allowance < rewardAmount) {
      const approveTx = await this._usdc.approve(this._network.escrow, rewardAmount)
      await approveTx.wait()
    }

    // 4. Create task on-chain
    const tx = await this._escrow.createTask(specHash, rewardAmount)
    const receipt = await tx.wait()

    // Extract taskId from TaskCreated event
    const event = receipt.logs
      .map(log => { try { return this._escrow.interface.parseLog(log) } catch { return null } })
      .find(e => e && e.name === 'TaskCreated')

    const taskId = event ? event.args.taskId : null

    return { taskId, specHash, txHash: tx.hash }
  }

  /**
   * Cancel an open task and get a full USDC refund.
   */
  async cancelTask(taskId) {
    const tx = await this._escrow.cancelTask(taskId)
    await tx.wait()
    return { txHash: tx.hash }
  }

  // ── Executor actions ────────────────────────────────────────────────────────

  /**
   * Accept a task and deposit the slashing bond (5% of reward).
   */
  async acceptTask(taskId) {
    const task = await this.getTask(taskId)
    const bond = BigInt(task.rewardUsdc) * 500n / 10000n

    const allowance = await this._usdc.allowance(this._signer.address, this._network.escrow)
    if (allowance < bond) {
      const approveTx = await this._usdc.approve(this._network.escrow, bond)
      await approveTx.wait()
    }

    const tx = await this._escrow.acceptTask(taskId)
    await tx.wait()
    return { txHash: tx.hash }
  }

  /**
   * Submit result: store implementation off-chain, get resultHash, call submitResult().
   *
   * @param {object} opts
   * @param {string} opts.taskId
   * @param {string} opts.implementation   The code/solution string
   * @returns {{ resultHash, txHash }}
   */
  async submitResult({ taskId, implementation }) {
    // Store result off-chain
    const { result_hash: resultHash } = await this._apiPost('/results', {
      task_id: taskId,
      implementation,
    })

    const tx = await this._escrow.submitResult(taskId, resultHash)
    await tx.wait()
    return { resultHash, txHash: tx.hash }
  }

  /**
   * Raise a dispute within 24h of verification.
   */
  async raiseDispute(taskId) {
    const tx = await this._escrow.raiseDispute(taskId)
    await tx.wait()
    return { txHash: tx.hash }
  }

  // ── Read methods ────────────────────────────────────────────────────────────

  /**
   * Get task details.
   * @returns {{ poster, executor, rewardUsdc, status, statusName, ... }}
   */
  async getTask(taskId) {
    const t = await this._escrow.getTask(taskId)
    return {
      poster:       t.poster,
      executor:     t.executor,
      rewardUsdc:   t.rewardUsdc.toString(),
      executorBond: t.executorBond.toString(),
      specHash:     t.specHash,
      resultHash:   t.resultHash,
      status:       Number(t.status),
      statusName:   TaskStatus[Number(t.status)] || 'UNKNOWN',
      createdAt:    Number(t.createdAt),
      acceptedAt:   Number(t.acceptedAt),
      verifiedAt:   Number(t.verifiedAt),
      verifierNote: t.verifierNote,
    }
  }

  /** Get task spec from API */
  async getSpec(specHash) {
    return this._apiGet(`/specs/${specHash}`)
  }

  /** Get USDC balance of an address (in dollars) */
  async usdcBalance(address) {
    const bal = await this._usdc.balanceOf(address || this._signer.address)
    return Number(bal) / 1e6
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _apiPost(path, body) {
    return this._apiRequest('POST', path, body)
  }

  _apiGet(path) {
    return this._apiRequest('GET', path)
  }

  _apiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._apiUrl + path)
      const isHttps = url.protocol === 'https:'
      const payload = body ? JSON.stringify(body) : null

      const opts = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      }

      const req = (isHttps ? https : http).request(opts, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.error) reject(new Error(json.error))
            else resolve(json)
          } catch (e) {
            reject(new Error(`API parse error: ${data.slice(0, 200)}`))
          }
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  EscrixClient,
  CONTRACTS,
  TaskStatus,
  version: '0.1.0',
}
