"""
Escrix on-chain client — web3.py wrapper for EscrixEscrow contract.
Handles USDC approval, task creation, acceptance, and result submission.

Install dependency: pip install escrix[web3]
"""

from __future__ import annotations
from typing import Optional
import json

CONTRACTS = {
    "baseMainnet": {
        "escrow": "0x26031eF27DC648E18d53858197EfA03Bdd1Ba01a",
        "usdc":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "chain_id": 8453,
        "rpc_url": "https://mainnet.base.org",
    },
    "baseSepolia": {
        "escrow": "0x51F74f85dccD5F5048e2De44A6F4221Fc7c20574",
        "usdc":   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "chain_id": 84532,
        "rpc_url": "https://sepolia.base.org",
    },
}

ESCROW_ABI = [
    {"type": "function", "name": "createTask",
     "inputs": [{"name": "specHash", "type": "bytes32"}, {"name": "rewardUsdc", "type": "uint256"}],
     "outputs": [{"name": "taskId", "type": "bytes32"}], "stateMutability": "nonpayable"},
    {"type": "function", "name": "acceptTask",
     "inputs": [{"name": "taskId", "type": "bytes32"}],
     "outputs": [], "stateMutability": "nonpayable"},
    {"type": "function", "name": "submitResult",
     "inputs": [{"name": "taskId", "type": "bytes32"}, {"name": "resultHash", "type": "bytes32"}],
     "outputs": [], "stateMutability": "nonpayable"},
    {"type": "function", "name": "getTask",
     "inputs": [{"name": "taskId", "type": "bytes32"}],
     "outputs": [{"name": "", "type": "tuple", "components": [
         {"name": "poster", "type": "address"},
         {"name": "executor", "type": "address"},
         {"name": "rewardUsdc", "type": "uint256"},
         {"name": "executorBond", "type": "uint256"},
         {"name": "specHash", "type": "bytes32"},
         {"name": "resultHash", "type": "bytes32"},
         {"name": "status", "type": "uint8"},
         {"name": "createdAt", "type": "uint256"},
         {"name": "acceptedAt", "type": "uint256"},
         {"name": "verifiedAt", "type": "uint256"},
         {"name": "verifierNote", "type": "string"},
     ]}], "stateMutability": "view"},
    {"type": "event", "name": "TaskCreated",
     "inputs": [
         {"name": "taskId", "type": "bytes32", "indexed": True},
         {"name": "poster", "type": "address", "indexed": False},
         {"name": "rewardUsdc", "type": "uint256", "indexed": False},
         {"name": "specHash", "type": "bytes32", "indexed": False},
     ]},
]

ERC20_ABI = [
    {"type": "function", "name": "approve",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}], "stateMutability": "nonpayable"},
    {"type": "function", "name": "allowance",
     "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
    {"type": "function", "name": "balanceOf",
     "inputs": [{"name": "account", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}], "stateMutability": "view"},
]

TASK_STATUS = {
    0: "OPEN", 1: "ACCEPTED", 2: "SUBMITTED",
    3: "VERIFIED_PASS", 4: "VERIFIED_FAIL", 5: "DISPUTED", 6: "CANCELLED",
}


class EscrixChainClient:
    """
    On-chain client for EscrixEscrow. Requires web3.py.

    Example:
        from escrix.chain import EscrixChainClient
        client = EscrixChainClient(private_key="0x...", network="baseMainnet")
        tx = client.create_task(spec_hash="0x...", reward_usdc=5.0)
    """

    def __init__(
        self,
        private_key: str,
        network: str = "baseMainnet",
        rpc_url: Optional[str] = None,
    ):
        try:
            from web3 import Web3
            from eth_account import Account
        except ImportError:
            raise ImportError(
                "web3 is required for on-chain operations. "
                "Install it with: pip install escrix[web3]"
            )

        net = CONTRACTS.get(network)
        if not net:
            raise ValueError(f"Unknown network: {network}. Use 'baseMainnet' or 'baseSepolia'.")

        self._net = net
        self._w3  = Web3(Web3.HTTPProvider(rpc_url or net["rpc_url"]))
        self._account = self._w3.eth.account.from_key(private_key)
        self._escrow  = self._w3.eth.contract(
            address=Web3.to_checksum_address(net["escrow"]),
            abi=ESCROW_ABI,
        )
        self._usdc = self._w3.eth.contract(
            address=Web3.to_checksum_address(net["usdc"]),
            abi=ERC20_ABI,
        )

    @property
    def address(self) -> str:
        return self._account.address

    def usdc_balance(self, address: Optional[str] = None) -> float:
        """Return USDC balance in dollars."""
        addr = address or self.address
        raw  = self._usdc.functions.balanceOf(addr).call()
        return raw / 1_000_000

    def create_task(self, spec_hash: str, reward_usdc: float) -> dict:
        """
        Approve USDC and call createTask() on-chain.
        Returns {"task_id": ..., "tx_hash": ...}
        """
        reward_raw = int(reward_usdc * 1_000_000)
        self._ensure_allowance(reward_raw)

        spec_bytes = bytes.fromhex(spec_hash.removeprefix("0x"))
        tx = self._send(
            self._escrow.functions.createTask(spec_bytes, reward_raw)
        )
        receipt = self._w3.eth.wait_for_transaction_receipt(tx, timeout=120)

        # Extract taskId from TaskCreated event
        logs = self._escrow.events.TaskCreated().process_receipt(receipt)
        task_id = "0x" + logs[0]["args"]["taskId"].hex() if logs else None

        return {"task_id": task_id, "tx_hash": "0x" + receipt["transactionHash"].hex()}

    def accept_task(self, task_id: str) -> dict:
        """Deposit slashing bond and accept a task."""
        task      = self.get_task(task_id)
        bond_raw  = int(task["reward_usdc_raw"]) * 500 // 10_000
        self._ensure_allowance(bond_raw)

        task_bytes = bytes.fromhex(task_id.removeprefix("0x"))
        tx = self._send(self._escrow.functions.acceptTask(task_bytes))
        receipt = self._w3.eth.wait_for_transaction_receipt(tx, timeout=120)
        return {"tx_hash": "0x" + receipt["transactionHash"].hex()}

    def submit_result(self, task_id: str, result_hash: str) -> dict:
        """Submit result hash on-chain."""
        task_bytes   = bytes.fromhex(task_id.removeprefix("0x"))
        result_bytes = bytes.fromhex(result_hash.removeprefix("0x"))
        tx = self._send(
            self._escrow.functions.submitResult(task_bytes, result_bytes)
        )
        receipt = self._w3.eth.wait_for_transaction_receipt(tx, timeout=120)
        return {"tx_hash": "0x" + receipt["transactionHash"].hex()}

    def get_task(self, task_id: str) -> dict:
        """Get task details from chain."""
        task_bytes = bytes.fromhex(task_id.removeprefix("0x"))
        t = self._escrow.functions.getTask(task_bytes).call()
        return {
            "poster":         t[0],
            "executor":       t[1],
            "reward_usdc":    t[2] / 1_000_000,
            "reward_usdc_raw": t[2],
            "executor_bond":  t[3] / 1_000_000,
            "spec_hash":      "0x" + t[4].hex(),
            "result_hash":    "0x" + t[5].hex(),
            "status":         t[6],
            "status_name":    TASK_STATUS.get(t[6], "UNKNOWN"),
            "verifier_note":  t[10],
        }

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _ensure_allowance(self, amount_raw: int):
        """Approve USDC if current allowance is insufficient."""
        current = self._usdc.functions.allowance(
            self.address, self._net["escrow"]
        ).call()
        if current < amount_raw:
            tx = self._send(
                self._usdc.functions.approve(
                    self._net["escrow"],
                    amount_raw * 10,   # approve 10x to reduce future approvals
                )
            )
            self._w3.eth.wait_for_transaction_receipt(tx, timeout=60)

    def _send(self, fn) -> bytes:
        """Build, sign, and send a transaction."""
        nonce = self._w3.eth.get_transaction_count(self.address)
        tx = fn.build_transaction({
            "from":  self.address,
            "nonce": nonce,
            "chainId": self._net["chain_id"],
        })
        signed = self._w3.eth.account.sign_transaction(tx, self._account.key)
        return self._w3.eth.send_raw_transaction(signed.raw_transaction)
