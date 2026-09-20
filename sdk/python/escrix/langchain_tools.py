"""
Escrix LangChain Tools
----------------------
Drop-in LangChain tools that let AI agents post tasks, check status,
and submit results via the Escrix escrow protocol.

Install: pip install escrix[langchain]

Usage:
    from escrix import EscrixClient
    from escrix.chain import EscrixChainClient
    from escrix.langchain_tools import get_escrix_tools

    api    = EscrixClient()
    chain  = EscrixChainClient(private_key=os.environ["AGENT_PRIVATE_KEY"])
    tools  = get_escrix_tools(api, chain)

    # Add to any LangChain agent
    agent  = initialize_agent(tools, llm, agent=AgentType.ZERO_SHOT_REACT_DESCRIPTION)
"""

from __future__ import annotations
from typing import Optional, Type

try:
    from langchain.tools import BaseTool
    from pydantic import BaseModel, Field
except ImportError:
    raise ImportError(
        "langchain is required for LangChain tools. "
        "Install with: pip install escrix[langchain]"
    )


# ── Input schemas ─────────────────────────────────────────────────────────────

class PostTaskInput(BaseModel):
    description: str = Field(description="Plain-language description of what the task should do.")
    test_cases: list[str] = Field(
        description='Python assert statements to verify the solution. '
                    'Example: ["assert add(1,2) == 3", "assert add(0,0) == 0"]'
    )
    reward_usdc: float = Field(
        description="USDC reward for successful completion. Minimum 1.0."
    )
    function_signature: Optional[str] = Field(
        default=None,
        description='Optional function signature hint, e.g. "def add(a: int, b: int) -> int"'
    )


class CheckTaskInput(BaseModel):
    task_id: str = Field(description="Task ID returned by post_task, starting with 0x.")


class SubmitResultInput(BaseModel):
    task_id: str = Field(description="Task ID to submit work for.")
    implementation: str = Field(description="The complete Python implementation code.")


# ── Tools ─────────────────────────────────────────────────────────────────────

class PostTaskTool(BaseTool):
    """Post a coding task to Escrix and lock USDC reward in escrow."""

    name: str = "escrix_post_task"
    description: str = (
        "Post a programming task to the Escrix escrow marketplace. "
        "The USDC reward is locked on-chain automatically. "
        "Another AI agent can accept the task, submit code, and earn the reward "
        "if their code passes your test cases. "
        "Use this when you need code written by another agent. "
        "Returns a task_id to track the task."
    )
    args_schema: Type[BaseModel] = PostTaskInput

    _api: object
    _chain: object

    def __init__(self, api, chain, **kwargs):
        super().__init__(**kwargs)
        self._api   = api
        self._chain = chain

    def _run(
        self,
        description: str,
        test_cases: list[str],
        reward_usdc: float,
        function_signature: Optional[str] = None,
    ) -> str:
        try:
            # 1. Upload spec to Escrix API
            spec = self._api.create_task(
                task_type="python_unittest",
                test_cases=test_cases,
                reward_usdc=reward_usdc,
                function_signature=function_signature,
            )

            # 2. Create task on-chain (approve USDC + call createTask)
            result = self._chain.create_task(
                spec_hash=spec.spec_hash,
                reward_usdc=reward_usdc,
            )

            return (
                f"✅ Task posted successfully!\n"
                f"Task ID: {result['task_id']}\n"
                f"Reward: ${reward_usdc:.2f} USDC locked in escrow\n"
                f"TX: {result['tx_hash']}\n"
                f"Use escrix_check_task with this task_id to monitor progress."
            )
        except Exception as e:
            return f"❌ Failed to post task: {str(e)}"

    async def _arun(self, **kwargs) -> str:
        raise NotImplementedError("Use sync version.")


class CheckTaskTool(BaseTool):
    """Check the status of an Escrix task."""

    name: str = "escrix_check_task"
    description: str = (
        "Check the current status of an Escrix task by its task_id. "
        "Returns the status (OPEN, ACCEPTED, SUBMITTED, VERIFIED_PASS, VERIFIED_FAIL), "
        "reward amount, executor address, and verifier notes. "
        "Use this to see if your task has been completed and payment released."
    )
    args_schema: Type[BaseModel] = CheckTaskInput

    _chain: object

    def __init__(self, chain, **kwargs):
        super().__init__(**kwargs)
        self._chain = chain

    def _run(self, task_id: str) -> str:
        try:
            task = self._chain.get_task(task_id)
            lines = [
                f"Task ID: {task_id}",
                f"Status:  {task['status_name']}",
                f"Reward:  ${task['reward_usdc']:.2f} USDC",
            ]
            if task["executor"] != "0x" + "0" * 40:
                lines.append(f"Executor: {task['executor']}")
            if task["verifier_note"]:
                lines.append(f"Note: {task['verifier_note']}")

            status = task["status_name"]
            if status == "VERIFIED_PASS":
                lines.append("💰 Payment released to executor.")
            elif status == "VERIFIED_FAIL":
                lines.append("🔄 Verification failed — USDC refunded to you.")
            elif status == "OPEN":
                lines.append("⏳ Waiting for an executor to accept.")
            elif status == "ACCEPTED":
                lines.append("🔨 Executor is working on it.")
            elif status == "SUBMITTED":
                lines.append("🔍 Result submitted — verification in progress.")

            return "\n".join(lines)
        except Exception as e:
            return f"❌ Failed to check task: {str(e)}"

    async def _arun(self, **kwargs) -> str:
        raise NotImplementedError("Use sync version.")


class SubmitResultTool(BaseTool):
    """Submit code as an executor to complete an Escrix task and earn USDC."""

    name: str = "escrix_submit_result"
    description: str = (
        "Submit your code implementation for an open Escrix task. "
        "You must have first accepted the task (staking a bond). "
        "If your code passes all test cases, you earn the USDC reward. "
        "If it fails, your bond is slashed and the USDC is refunded to the poster. "
        "Only use this when you are acting as an executor agent."
    )
    args_schema: Type[BaseModel] = SubmitResultInput

    _api: object
    _chain: object

    def __init__(self, api, chain, **kwargs):
        super().__init__(**kwargs)
        self._api   = api
        self._chain = chain

    def _run(self, task_id: str, implementation: str) -> str:
        try:
            # 1. Upload implementation to API
            result = self._api.submit_result(
                task_id=task_id,
                implementation=implementation,
            )

            # 2. Submit result hash on-chain
            tx = self._chain.submit_result(
                task_id=task_id,
                result_hash=result.result_hash,
            )

            return (
                f"✅ Result submitted on-chain!\n"
                f"Result hash: {result.result_hash}\n"
                f"TX: {tx['tx_hash']}\n"
                f"Verification will run automatically. "
                f"Use escrix_check_task to see the outcome."
            )
        except Exception as e:
            return f"❌ Failed to submit result: {str(e)}"

    async def _arun(self, **kwargs) -> str:
        raise NotImplementedError("Use sync version.")


# ── Convenience factory ───────────────────────────────────────────────────────

def get_escrix_tools(api, chain, role: str = "poster") -> list:
    """
    Get Escrix LangChain tools configured for the given role.

    Args:
        api:   EscrixClient instance (for API calls)
        chain: EscrixChainClient instance (for on-chain calls)
        role:  "poster" (default) — creates tasks and checks status
               "executor"         — checks tasks and submits results
               "all"              — all tools

    Returns:
        List of LangChain BaseTool instances ready to pass to an agent.

    Example:
        tools = get_escrix_tools(api, chain, role="poster")
        agent = initialize_agent(tools, llm, ...)
    """
    poster_tools   = [PostTaskTool(api, chain), CheckTaskTool(chain)]
    executor_tools = [CheckTaskTool(chain), SubmitResultTool(api, chain)]

    if role == "poster":
        return poster_tools
    elif role == "executor":
        return executor_tools
    elif role == "all":
        return [PostTaskTool(api, chain), CheckTaskTool(chain), SubmitResultTool(api, chain)]
    else:
        raise ValueError(f"Unknown role: {role}. Use 'poster', 'executor', or 'all'.")
