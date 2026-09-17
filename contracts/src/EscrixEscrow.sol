// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  EscrixEscrow
 * @notice AI Agent-to-Agent programmable escrow with deterministic task verification.
 *         Deployed on Base (Coinbase L2). Settles in USDC.
 *
 * Flow:
 *   1. Poster calls createTask() → deposits USDC → task is OPEN
 *   2. Executor calls acceptTask() → locks in as executor, deposits slashing bond
 *   3. Executor submits work off-chain, calls submitResult() with a result hash
 *   4. Escrix Verifier Node runs deterministic sandbox, calls verify() → PASS or FAIL
 *   5. PASS → USDC released to Executor, bond returned
 *      FAIL → USDC refunded to Poster, bond slashed to Escrix treasury
 *   6. Either party can raise a dispute within DISPUTE_WINDOW after verify()
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract EscrixEscrow {

    // ── Constants ──────────────────────────────────────────────────────────────
    address public immutable USDC; // set in constructor (mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    uint256 public constant DISPUTE_WINDOW  = 24 hours;
    uint256 public constant EXECUTOR_WINDOW = 48 hours; // time to accept after posting
    uint256 public constant SLASH_BPS       = 500;      // 5% of reward slashed on fail
    uint256 public constant PROTOCOL_FEE_BPS = 30;      // 0.3% protocol fee

    // ── Roles ──────────────────────────────────────────────────────────────────
    address public owner;
    address public treasury;
    mapping(address => bool) public verifierNodes; // authorized Escrix verifier nodes

    // ── Task lifecycle ─────────────────────────────────────────────────────────
    enum Status { OPEN, ACCEPTED, SUBMITTED, VERIFIED_PASS, VERIFIED_FAIL, DISPUTED, CANCELLED }

    struct Task {
        address poster;
        address executor;
        uint256 rewardUsdc;      // USDC held in escrow (reward to executor on pass)
        uint256 executorBond;    // USDC deposited by executor (slashed on fail)
        bytes32 specHash;        // keccak256 of off-chain task specification JSON
        bytes32 resultHash;      // keccak256 of executor's submitted result
        Status  status;
        uint256 createdAt;
        uint256 acceptedAt;
        uint256 verifiedAt;
        string  verifierNote;    // human-readable reason from verifier node
    }

    mapping(bytes32 => Task) public tasks;
    uint256 public taskCount;
    uint256 public protocolFeesAccrued;

    // ── Events ─────────────────────────────────────────────────────────────────
    event TaskCreated   (bytes32 indexed taskId, address poster,   uint256 rewardUsdc, bytes32 specHash);
    event TaskAccepted  (bytes32 indexed taskId, address executor, uint256 bond);
    event ResultSubmitted(bytes32 indexed taskId, bytes32 resultHash);
    event TaskVerified  (bytes32 indexed taskId, bool passed, string note);
    event TaskDisputed  (bytes32 indexed taskId, address by);
    event TaskCancelled (bytes32 indexed taskId);
    event VerifierUpdated(address verifier, bool authorized);

    // ── Modifiers ──────────────────────────────────────────────────────────────
    modifier onlyOwner()    { require(msg.sender == owner,    "not owner");    _; }
    modifier onlyVerifier() { require(verifierNodes[msg.sender], "not verifier"); _; }

    // ── Constructor ────────────────────────────────────────────────────────────
    /**
     * @param _treasury  Address that receives protocol fees and slashed bonds
     * @param _usdc      USDC token address (Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
     *                                       (Base Sepolia:  0x036CbD53842c5426634e7929541eC2318f3dCF7e)
     */
    constructor(address _treasury, address _usdc) {
        owner    = msg.sender;
        treasury = _treasury;
        USDC     = _usdc;
        verifierNodes[msg.sender] = true; // deployer is initial verifier
    }

    // ── Task creation ──────────────────────────────────────────────────────────

    /**
     * @notice Create a task and lock the reward in escrow.
     * @param specHash    keccak256 of the task specification JSON (stored off-chain / IPFS)
     * @param rewardUsdc  USDC reward for successful completion (6 decimals)
     * @return taskId     unique task identifier
     */
    function createTask(bytes32 specHash, uint256 rewardUsdc) external returns (bytes32 taskId) {
        require(rewardUsdc >= 1e6, "min reward 1 USDC"); // at least 1 USDC

        taskId = keccak256(abi.encodePacked(msg.sender, specHash, block.timestamp, taskCount++));

        // Pull USDC from poster
        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), rewardUsdc),
            "USDC transfer failed"
        );

        tasks[taskId] = Task({
            poster:       msg.sender,
            executor:     address(0),
            rewardUsdc:   rewardUsdc,
            executorBond: 0,
            specHash:     specHash,
            resultHash:   bytes32(0),
            status:       Status.OPEN,
            createdAt:    block.timestamp,
            acceptedAt:   0,
            verifiedAt:   0,
            verifierNote: ""
        });

        emit TaskCreated(taskId, msg.sender, rewardUsdc, specHash);
    }

    /**
     * @notice Accept an open task and deposit a slashing bond.
     *         Bond = SLASH_BPS% of reward (ensures executor has skin in the game).
     */
    function acceptTask(bytes32 taskId) external {
        Task storage t = tasks[taskId];
        require(t.status == Status.OPEN,                      "task not open");
        require(t.poster != msg.sender,                       "poster cannot execute");
        require(block.timestamp < t.createdAt + EXECUTOR_WINDOW, "acceptance window expired");

        uint256 bond = (t.rewardUsdc * SLASH_BPS) / 10_000;
        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), bond),
            "bond transfer failed"
        );

        t.executor    = msg.sender;
        t.executorBond = bond;
        t.status      = Status.ACCEPTED;
        t.acceptedAt  = block.timestamp;

        emit TaskAccepted(taskId, msg.sender, bond);
    }

    /**
     * @notice Executor submits result hash after completing the task off-chain.
     *         The actual result (code, data, etc.) is stored off-chain; only its
     *         hash is committed on-chain for tamper-evidence.
     */
    function submitResult(bytes32 taskId, bytes32 resultHash) external {
        Task storage t = tasks[taskId];
        require(t.status == Status.ACCEPTED, "task not accepted");
        require(t.executor == msg.sender,    "not the executor");

        t.resultHash = resultHash;
        t.status     = Status.SUBMITTED;

        emit ResultSubmitted(taskId, resultHash);
    }

    // ── Verification (called by authorized Escrix Verifier Node) ──────────────

    /**
     * @notice Verifier node calls this after running the deterministic sandbox.
     * @param passed  true = task passed verification, false = failed
     * @param note    human-readable explanation (stored for audit trail)
     */
    function verify(bytes32 taskId, bool passed, string calldata note) external onlyVerifier {
        Task storage t = tasks[taskId];
        require(t.status == Status.SUBMITTED, "not submitted");

        t.verifiedAt   = block.timestamp;
        t.verifierNote = note;

        uint256 fee = (t.rewardUsdc * PROTOCOL_FEE_BPS) / 10_000;

        if (passed) {
            t.status = Status.VERIFIED_PASS;
            // Release: reward - fee → executor; bond → executor; fee → treasury
            require(IERC20(USDC).transfer(t.executor, t.rewardUsdc - fee + t.executorBond), "payout failed");
            protocolFeesAccrued += fee;
        } else {
            t.status = Status.VERIFIED_FAIL;
            // Slash: reward → poster; bond slashed → treasury
            require(IERC20(USDC).transfer(t.poster, t.rewardUsdc), "refund failed");
            protocolFeesAccrued += t.executorBond; // entire bond slashed
        }

        emit TaskVerified(taskId, passed, note);
    }

    // ── Dispute ────────────────────────────────────────────────────────────────

    /**
     * @notice Either party can raise a dispute within DISPUTE_WINDOW of verification.
     *         Disputed tasks are frozen; owner manually resolves via resolveDispute().
     */
    function raiseDispute(bytes32 taskId) external {
        Task storage t = tasks[taskId];
        require(
            t.status == Status.VERIFIED_PASS || t.status == Status.VERIFIED_FAIL,
            "not verifiable"
        );
        require(block.timestamp < t.verifiedAt + DISPUTE_WINDOW, "dispute window closed");
        require(msg.sender == t.poster || msg.sender == t.executor, "not a party");

        t.status = Status.DISPUTED;
        emit TaskDisputed(taskId, msg.sender);
    }

    /**
     * @notice Owner resolves a dispute manually.
     * @param payExecutor  true → release to executor, false → refund to poster
     */
    function resolveDispute(bytes32 taskId, bool payExecutor) external onlyOwner {
        Task storage t = tasks[taskId];
        require(t.status == Status.DISPUTED, "not disputed");

        if (payExecutor) {
            t.status = Status.VERIFIED_PASS;
            require(IERC20(USDC).transfer(t.executor, t.rewardUsdc + t.executorBond), "payout failed");
        } else {
            t.status = Status.VERIFIED_FAIL;
            require(IERC20(USDC).transfer(t.poster, t.rewardUsdc), "refund failed");
            protocolFeesAccrued += t.executorBond;
        }
    }

    // ── Cancellation ───────────────────────────────────────────────────────────

    /**
     * @notice Poster can cancel an OPEN task (no executor yet) for a full refund.
     */
    function cancelTask(bytes32 taskId) external {
        Task storage t = tasks[taskId];
        require(t.status == Status.OPEN,    "can only cancel open tasks");
        require(t.poster == msg.sender,     "not the poster");

        t.status = Status.CANCELLED;
        require(IERC20(USDC).transfer(t.poster, t.rewardUsdc), "refund failed");
        emit TaskCancelled(taskId);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    function setVerifier(address verifier, bool authorized) external onlyOwner {
        verifierNodes[verifier] = authorized;
        emit VerifierUpdated(verifier, authorized);
    }

    function withdrawFees() external onlyOwner {
        uint256 amount = protocolFeesAccrued;
        protocolFeesAccrued = 0;
        require(IERC20(USDC).transfer(treasury, amount), "fee withdrawal failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ── View ───────────────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return tasks[taskId];
    }
}
