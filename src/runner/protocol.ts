/**
 * NDJSON protocol between the gateway and the runner container.
 *
 * One JSON object per line on the container's stdout (runner→gateway); the
 * runner's own logs go to stderr only.
 *
 * This file is one of TWO byte-identical copies — src/runner/protocol.ts
 * (gateway side) and runner/src/protocol.ts (container side). The runner cannot
 * import from the gateway package at container build time, so the contract is
 * duplicated rather than shared. These two files are the only contract between
 * the two processes.
 *
 * When you add or change a message type, edit BOTH copies in the same change and
 * verify they still match:
 *     diff src/runner/protocol.ts runner/src/protocol.ts   # must print nothing
 */

// ── Gateway → Runner ──────────────────────────────────────────────────────────

export type GatewayToRunnerMessage =
  | UserMessage
  | ApprovalVerdictMessage
  | CloneResultMessage
  | BuildResultMessage
  | ExecResultMessage
  | PublishResultMessage
  | PrEditResultMessage
  | PrCommentResultMessage
  | RunChecksResultMessage
  | ProvisionResultMessage;

export type UserMessage = {
  type: 'user_message';
  /** Correlation ID — echoed back on the response events */
  id: string;
  text: string;
};

/**
 * The gateway's verdict on a commit gate the runner raised via a
 * {@link RequestApprovalMessage} (the router's commit, design/0007 decision 5).
 *
 * Sent only AFTER the gateway has run its requestor-only, fail-closed approval check, so the
 * container may treat `approved: true` as an authorized human commit — the model can never
 * self-approve. `id` echoes the `request_approval` this answers. `specRef` is the gateway-held
 * SPEC identity the human saw, echoed back over the trusted channel so a recreated runner never
 * reconstructs the id→SPEC binding from agent-writable disk. `feedback` carries the requestor's
 * reply when the gate was not a plain commit keyword (`approved: false`), so the agent can revise
 * and ask again; it is absent on a clean approval. (`exactOptionalPropertyTypes` is on —
 * `feedback` is genuinely optional, never `undefined`-valued.)
 */
export type ApprovalVerdictMessage = {
  type: 'approval_verdict';
  id: string;
  specRef: string;
  approved: boolean;
  feedback?: string;
};

/**
 * The gateway's result of a credentialed clone the runner requested via a
 * {@link RequestCloneMessage}. Sent immediately after the clone completes (inline,
 * no human hop). `id` echoes the `request_clone` this answers. `workdir` is the
 * local path inside the container where the tree landed (present iff `ok`). `error`
 * is a short diagnostic (present iff `!ok`). (`exactOptionalPropertyTypes` is on —
 * `workdir` and `error` are genuinely optional, never `undefined`-valued.)
 */
export type CloneResultMessage = {
  type: 'clone_result';
  id: string;
  ok: boolean;
  workdir?: string; // present iff ok
  error?: string;   // present iff !ok
};

/**
 * The gateway's result of a build the runner requested via a {@link RequestBuildMessage}.
 * Sent after the build tail completes (the gateway runs a fresh implementer container on the
 * session's shared volume, via S12a's engine). `id` echoes the `request_build` this answers.
 * Success means a local candidate is ready on that shared volume. `prUrl` is tolerated only as a
 * legacy rolling-compatibility field; the gateway no longer emits it for current build success.
 * `reason` is a short diagnostic (present iff `!ok`, token-free). (`exactOptionalPropertyTypes`
 * is on — `prUrl` and `reason` are genuinely optional, never `undefined`-valued.)
 */
export type BuildResultMessage = {
  type: 'build_result';
  id: string;       // echoes the request_build this answers
  ok: boolean;
  prUrl?: string;   // tolerated legacy field on ok:true
  reason?: string;  // present iff !ok — short, token-free
};

/**
 * The gateway's result of an unsupervised exec run the router requested via a
 * {@link RequestExecMessage}. `id` echoes the `request_exec` this answers. `prUrl` is present
 * when the unchanged repo-oneshot blueprint opened a PR; `reason` is a short diagnostic or
 * authorization refusal (present iff `!ok`, token-free). The gateway, not the container, decides
 * whether the requestor has an explicit recorded opt-in. (`exactOptionalPropertyTypes` is on —
 * `prUrl` and `reason` are genuinely optional, never `undefined`-valued.)
 */
export type ExecResultMessage = {
  type: 'exec_result';
  id: string;       // echoes the request_exec this answers
  ok: boolean;
  prUrl?: string;   // present iff ok and a PR was opened
  reason?: string;  // present iff !ok — short, token-free
};

/**
 * The gateway's result of publishing a verified local candidate the runner requested via a
 * {@link RequestPublishMessage}. `id` echoes the `request_publish` this answers. `prUrl` is the
 * opened PR URL (present iff `ok`). `reason` is a short diagnostic (present iff `!ok`, token-free).
 * (`exactOptionalPropertyTypes` is on — `prUrl` and `reason` are genuinely optional, never
 * `undefined`-valued.)
 */
export type PublishResultMessage = {
  type: 'publish_result';
  id: string;       // echoes the request_publish this answers
  ok: boolean;
  prUrl?: string;   // present iff ok
  reason?: string;  // present iff !ok — short, token-free
};

/**
 * The gateway's result of editing this thread's PR the runner requested via a
 * {@link RequestPrEditMessage}. `id` echoes the `request_pr_edit` this answers.
 * `reason` is a short diagnostic (present iff `!ok`, token-free).
 */
export type PrEditResultMessage = {
  type: 'pr_edit_result';
  id: string;       // echoes the request_pr_edit this answers
  ok: boolean;
  reason?: string;  // present iff !ok — short, token-free
};

/**
 * The gateway's result of commenting on this thread's PR the runner requested via a
 * {@link RequestPrCommentMessage}. `id` echoes the `request_pr_comment` this answers.
 * `reason` is a short diagnostic (present iff `!ok`, token-free).
 */
export type PrCommentResultMessage = {
  type: 'pr_comment_result';
  id: string;       // echoes the request_pr_comment this answers
  ok: boolean;
  reason?: string;  // present iff !ok — short, token-free
};

export type CheckKind = 'lint' | 'test';
export type RunChecksKind = CheckKind | 'all';

export type RunChecksResult = {
  kind: CheckKind;
  exitCode: number;
  skipped: boolean;
  output: string;
};

/**
 * The gateway's result of deterministic project checks the runner requested via a
 * {@link RequestRunChecksMessage}. `id` echoes the `request_run_checks` this answers.
 * `ok:true` means the requested checks ran; a non-zero check exit is returned as data in
 * `results`, not as a protocol failure. `reason` is a short diagnostic for malformed input or
 * gateway infrastructure/service failures. (`exactOptionalPropertyTypes` is on — `results` and
 * `reason` are genuinely optional, never `undefined`-valued.)
 */
export type RunChecksResultMessage = {
  type: 'run_checks_result';
  id: string;                 // echoes the request_run_checks this answers
  ok: boolean;
  results?: RunChecksResult[]; // present iff ok
  reason?: string;            // present iff !ok — short, token-free
};

/**
 * The gateway's result of provisioning a pinned runtime the runner requested via a
 * {@link RequestProvisionMessage}. `id` echoes the `request_provision` this answers.
 * `error` is a short diagnostic (present iff `!ok`, token-free).
 */
export type ProvisionResultMessage = {
  type: 'provision_result';
  id: string;
  ok: boolean;
  error?: string;
};

// ── Runner → Gateway ──────────────────────────────────────────────────────────

export type RunnerToGatewayMessage =
  | ReadyMessage
  | StatusMessage
  | FileMessage
  | TextMessage
  | UsageMessage
  | DecisionMessage
  | RequestApprovalMessage
  | RequestCloneMessage
  | RequestBuildMessage
  | RequestExecMessage
  | RequestPublishMessage
  | RequestPrEditMessage
  | RequestPrCommentMessage
  | RequestRunChecksMessage
  | RequestProvisionMessage
  | ErrorMessage;

/** Emitted once when the runner is ready to accept input. */
export type ReadyMessage = {
  type: 'ready';
};

/** Progress note (tool use, etc.). May be emitted multiple times per turn. */
export type StatusMessage = {
  type: 'status';
  id: string;
  text: string;
};

/**
 * File produced during the turn.
 * Emitted zero or more times per turn, always before the final text/error.
 */
export type FileMessage = {
  type: 'file';
  id: string;
  name: string;
  data_base64: string;
  size: number;
};

/** Final assistant text for this turn. Emitted exactly once per user_message. */
export type TextMessage = {
  type: 'text';
  id: string;
  text: string;
};

/**
 * Per-turn cost + token usage. Emitted exactly once per user_message, just before
 * the terminal text/error — and on error/abandoned turns too, because they still
 * cost money. The gateway records this to the audit ledger as data; it is never
 * acted on as control. Dedicated (not bolted onto `text`) so turns that emit no
 * text still report cost.
 */
export type UsageMessage = {
  type: 'usage';
  id: string;
  /** Per-turn cost in integer micro-USD: round(total_cost_usd * 1e6). */
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * The coordinator's verification verdict for the current turn. Emitted zero or
 * more times per user_message after the agent reviews the diff and checks. The
 * gateway records this to the audit ledger as data; it is never acted on as
 * control, never blocks the turn, and never expects a response.
 */
export type DecisionMessage = {
  type: 'decision';
  id: string;
  point: 'verify';
  verdict: 'pass' | 'fail';
  rationale: string;
  correlationId?: string;
};

/**
 * The runner asks the human to commit — the router's commit gate (design/0007 decision 5).
 *
 * Raised from INSIDE a turn: the agent calls its `build_spec` tool (phase ①), which emits this
 * line and blocks until the gateway answers with an {@link ApprovalVerdictMessage} bearing the
 * same `id`. The gateway parks the turn, posts `specRef`, and runs its requestor-only approval
 * check before replying — raising the gate is the model raising its hand, not approving itself.
 * `id` is the runner's own approval-correlation id (distinct from the turn id; a turn could raise
 * more than one gate). `specRef` is the spec the human approves — a `/workspace` path (S11+).
 */
export type RequestApprovalMessage = {
  type: 'request_approval';
  id: string;
  specRef: string;
};

/**
 * The runner requests a credentialed clone of a repository (the router's investigation gate,
 * design/0007 decision 5 extension). Raised from INSIDE a turn: the agent calls its
 * `clone_repo` tool, which emits this line and blocks until the gateway answers with a
 * {@link CloneResultMessage} bearing the same `id`. The gateway services the clone inline
 * (no human hop) — it mints a READ lease, clones via a git container, revokes the lease,
 * and returns the local path where the tree landed. The credential never enters the agent env.
 * `id` is the runner's own clone-correlation id (distinct from the turn id). `repo` is the
 * "owner/name" slug the agent wants to investigate.
 */
export type RequestCloneMessage = {
  type: 'request_clone';
  id: string;    // the runner's own clone-correlation id
  repo: string;  // "owner/name"
};

/**
 * The runner requests a build of an approved spec (the router's build gate, design/0007 decision 5
 * extension). Raised from INSIDE a turn: the agent calls its `build_spec` tool (phase ②, after
 * approval), which emits this line and blocks until the gateway answers with a
 * {@link BuildResultMessage} bearing the same `id`. The gateway services the build via S12a's
 * engine — a fresh implementer container on the session's shared volume — and returns
 * candidate-ready success (or a failure reason). This local build path does not push or open a PR;
 * publish/open_pr is the explicit later step after coordinator verification. `id` is the runner's
 * own build-correlation id (distinct from the turn id). `repo` is the "owner/name" slug the
 * coordinator wants built.
 */
export type RequestBuildMessage = {
  type: 'request_build';
  id: string;    // the runner's own build-correlation id
  repo: string;  // "owner/name" — the cloned repo the coordinator wants built
};

export type ExecHost = 'github' | 'gitlab';

/**
 * The runner requests unsupervised execution via the unchanged repo-oneshot blueprint. Raised from
 * INSIDE a turn: the agent calls its `exec` tool, which emits this line and blocks until the gateway
 * answers with an {@link ExecResultMessage} bearing the same `id`. The gateway services this only
 * when the original requestor has an explicit recorded opt-in; no-requestor contexts fail closed.
 * `instruction` is the task text for repo-oneshot and is treated as untrusted data by the gateway.
 */
export type RequestExecMessage = {
  type: 'request_exec';
  id: string;             // the runner's own exec-correlation id
  host: ExecHost;
  repo: string;           // "owner/name"
  instruction: string;    // task text for the unsupervised blueprint
};

/**
 * The runner requests publication of a verified local candidate. Raised from INSIDE a turn: the
 * agent calls the `publish`/`open_pr` tool, which emits this line and blocks until the gateway
 * answers with a {@link PublishResultMessage} bearing the same `id`. The gateway services the
 * publish inline — it mints a WRITE lease, pushes the session volume's repo worktree, opens a PR,
 * revokes the lease, and returns the PR URL (or a failure reason). The credential never enters
 * the agent env. `id` is the runner's own publish-correlation id (distinct from the turn id).
 * `repo` is the strict "owner/name" slug whose workdir is derived by the gateway. `correlationId`
 * forwards the active build correlation id when the coordinator verified a candidate produced by
 * this turn's build, so the gateway can append-only join the later PR row to the earlier
 * verification decision.
 */
export type RequestPublishMessage = {
  type: 'request_publish';
  id: string;     // the runner's own publish-correlation id
  repo: string;   // "owner/name" — the verified repo candidate to publish
  title?: string; // optional PR title override
  body?: string;  // optional PR body override
  correlationId?: string;
};

/**
 * The runner requests that the gateway replace this thread PR's title/body. Raised from INSIDE a
 * turn: the agent calls the `edit_pr` tool, which emits this line and blocks until the gateway
 * answers with a {@link PrEditResultMessage} bearing the same `id`. The gateway resolves the PR
 * by this thread's deterministic head branch; the model never supplies a PR number.
 */
export type RequestPrEditMessage = {
  type: 'request_pr_edit';
  id: string;     // the runner's own pr-edit correlation id
  repo: string;   // "owner/name"
  title?: string; // optional new title
  body?: string;  // optional new body
};

/**
 * The runner requests that the gateway add a comment to this thread's PR. Raised from INSIDE a
 * turn: the agent calls the `comment_pr` tool, which emits this line and blocks until the gateway
 * answers with a {@link PrCommentResultMessage} bearing the same `id`. The gateway resolves the
 * PR by this thread's deterministic head branch; the model never supplies a PR number.
 */
export type RequestPrCommentMessage = {
  type: 'request_pr_comment';
  id: string;      // the runner's own pr-comment correlation id
  repo: string;    // "owner/name"
  comment: string; // comment text
};

/**
 * The runner requests deterministic project checks for a local candidate. Raised from INSIDE a
 * turn: the agent calls the `run_checks` tool, which emits this line and blocks until the gateway
 * answers with a {@link RunChecksResultMessage} bearing the same `id`. The gateway services checks
 * inline on the session volume, verifies the repo binding first, and injects no credentials.
 * `kind` defaults to "all" when omitted; "all" runs lint then test in that order.
 */
export type RequestRunChecksMessage = {
  type: 'request_run_checks';
  id: string;             // the runner's own checks-correlation id
  repo: string;           // "owner/name" — the local candidate to check
  kind?: RunChecksKind;   // omitted means "all"
};

/**
 * The runner requests a pinned runtime be provisioned onto the shared session volume. Raised from
 * INSIDE a turn: the agent calls the `provision_runtime` tool, naming a catalog runtime such as
 * "python". The gateway resolves that name against its curated catalog and either installs the
 * pinned artifact or returns a refusal as data. The model never supplies a URL or checksum.
 */
export type RequestProvisionMessage = {
  type: 'request_provision';
  id: string;    // the runner's own provision-correlation id
  name: string;  // runtime catalog name, e.g. "python"
};

/** Per-message failure. The runner remains usable after an error. */
export type ErrorMessage = {
  type: 'error';
  id: string;
  message: string;
};
