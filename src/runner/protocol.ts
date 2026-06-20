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

export type GatewayToRunnerMessage = UserMessage | ApprovalVerdictMessage | CloneResultMessage;

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
 * self-approve. `id` echoes the `request_approval` this answers. `feedback` carries the
 * requestor's reply when the gate was not a plain commit keyword (`approved: false`), so the
 * agent can revise and ask again; it is absent on a clean approval. (`exactOptionalPropertyTypes`
 * is on — `feedback` is genuinely optional, never `undefined`-valued.)
 */
export type ApprovalVerdictMessage = {
  type: 'approval_verdict';
  id: string;
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

// ── Runner → Gateway ──────────────────────────────────────────────────────────

export type RunnerToGatewayMessage =
  | ReadyMessage
  | StatusMessage
  | FileMessage
  | TextMessage
  | UsageMessage
  | RequestApprovalMessage
  | RequestCloneMessage
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
 * The runner asks the human to commit — the router's commit gate (design/0007 decision 5).
 *
 * Raised from INSIDE a turn: the agent calls its `submit_spec` tool, which emits this line
 * and blocks until the gateway answers with an {@link ApprovalVerdictMessage} bearing the same
 * `id`. The gateway parks the turn, posts `specRef`, and runs its requestor-only approval check
 * before replying — raising the gate is the model raising its hand, not approving itself. `id`
 * is the runner's own approval-correlation id (distinct from the turn id; a turn could raise
 * more than one gate). `specRef` is the spec the human approves — a text blob in this slice; a
 * `/workspace` path arrives with S11.
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

/** Per-message failure. The runner remains usable after an error. */
export type ErrorMessage = {
  type: 'error';
  id: string;
  message: string;
};
