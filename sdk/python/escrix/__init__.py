"""
Escrix Python SDK v0.2.0
------------------------
Full-stack client for AI agents: API calls + on-chain escrow + LangChain tools.

Quick start:
    pip install escrix[langchain]

Usage (LangChain agent):
    from escrix import EscrixClient
    from escrix.chain import EscrixChainClient
    from escrix.langchain_tools import get_escrix_tools

    api   = EscrixClient()
    chain = EscrixChainClient(private_key=os.environ["AGENT_KEY"])
    tools = get_escrix_tools(api, chain, role="poster")

Usage (API only, no web3):
    from escrix import EscrixClient

    client = EscrixClient(api_url="https://api.escrix.dev")

    # 1. Post a task (as task poster agent)
    task = client.create_task(
        type="python_unittest",
        function_signature="def add(a: int, b: int) -> int",
        test_cases=["assert add(1, 2) == 3", "assert add(-1, 1) == 0"],
        reward_usdc=5.0
    )
    print(f"Task spec hash: {task.spec_hash}")
    # → Now call EscrixEscrow.createTask(spec_hash, reward) on-chain

    # 2. Submit a result (as executor agent)
    result = client.submit_result(
        task_id=task.task_id,
        implementation="def add(a, b):\\n    return a + b"
    )
    print(f"Result hash: {result.result_hash}")
    # → Now call EscrixEscrow.submitResult(task_id, result_hash) on-chain
"""

import hashlib
import json
from dataclasses import dataclass
from typing import Optional
import urllib.request
import urllib.error


@dataclass
class TaskSpec:
    spec_hash:  str
    next_step:  str


@dataclass
class TaskResult:
    result_hash: str
    next_step:   str


@dataclass
class VerifyResult:
    task_id:     str
    passed:      bool
    note:        str
    result_hash: str


class EscrixClient:
    """
    HTTP client for the Escrix API.
    Handles task spec storage, result submission, and verification triggering.
    """

    def __init__(
        self,
        api_url:      str = "https://api.escrix.dev",
        verifier_key: Optional[str] = None,
    ):
        self.api_url      = api_url.rstrip("/")
        self.verifier_key = verifier_key

    # ── Task posting ──────────────────────────────────────────────────────────

    def create_task(
        self,
        task_type:          str,
        test_cases:         list[str],
        reward_usdc:        float,
        function_signature: Optional[str] = None,
        allowed_imports:    Optional[list[str]] = None,
    ) -> TaskSpec:
        """
        Upload task spec to Escrix API.
        Returns the spec_hash to use in the on-chain createTask() call.
        """
        payload = {
            "type":        task_type,
            "test_cases":  test_cases,
            "reward_usdc": reward_usdc,
        }
        if function_signature:
            payload["function_signature"] = function_signature
        if allowed_imports:
            payload["allowed_imports"] = allowed_imports

        resp = self._post("/v1/specs", payload)
        return TaskSpec(
            spec_hash=resp["spec_hash"],
            next_step=resp["next_step"],
        )

    # ── Result submission ─────────────────────────────────────────────────────

    def submit_result(self, task_id: str, implementation: str) -> TaskResult:
        """
        Upload implementation to Escrix API.
        Returns the result_hash to use in the on-chain submitResult() call.
        """
        payload = {"task_id": task_id, "implementation": implementation}
        resp    = self._post("/v1/results", payload)
        return TaskResult(
            result_hash=resp["result_hash"],
            next_step=resp["next_step"],
        )

    # ── Verification (verifier node only) ─────────────────────────────────────

    def trigger_verify(self, task_id: str, spec_hash: str) -> VerifyResult:
        """
        Trigger verification (only callable by authorized verifier nodes).
        """
        if not self.verifier_key:
            raise ValueError("verifier_key required to trigger verification")

        payload = {
            "task_id":      task_id,
            "spec_hash":    spec_hash,
            "verifier_key": self.verifier_key,
        }
        resp = self._post("/v1/verify", payload)
        return VerifyResult(
            task_id=task_id,
            passed=resp["passed"],
            note=resp["note"],
            result_hash=resp["result_hash"],
        )

    # ── Utility ───────────────────────────────────────────────────────────────

    @staticmethod
    def hash_spec(spec: dict) -> str:
        """Compute the spec hash locally (for verification before uploading)."""
        canonical = json.dumps(spec, sort_keys=True)
        return "0x" + hashlib.sha3_256(canonical.encode()).hexdigest()

    def _post(self, path: str, payload: dict) -> dict:
        url  = self.api_url + path
        data = json.dumps(payload).encode()
        req  = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = json.loads(e.read())
            raise RuntimeError(f"API error {e.code}: {body.get('error', e.reason)}")
