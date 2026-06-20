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

export type GatewayToRunnerMessage = UserMessage;

export type UserMessage = {
  type: 'user_message';
  /** Correlation ID — echoed back on the response events */
  id: string;
  text: string;
};

// ── Runner → Gateway ──────────────────────────────────────────────────────────

export type RunnerToGatewayMessage =
  | ReadyMessage
  | StatusMessage
  | FileMessage
  | TextMessage
  | UsageMessage
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

/** Per-message failure. The runner remains usable after an error. */
export type ErrorMessage = {
  type: 'error';
  id: string;
  message: string;
};
