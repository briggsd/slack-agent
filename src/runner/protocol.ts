/**
 * NDJSON protocol between the gateway and the runner container.
 *
 * One JSON object per line on stdout (runner→gateway).
 * The runner logs go to stderr only.
 *
 * The runner package imports this definition by copying its type shapes
 * verbatim into runner/src/protocol.ts (a local copy). This avoids
 * cross-package import at container build time while keeping one authoritative
 * source for the protocol contract.
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
  | TextMessage
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

/** Final assistant text for this turn. Emitted exactly once per user_message. */
export type TextMessage = {
  type: 'text';
  id: string;
  text: string;
};

/** Per-message failure. The runner remains usable after an error. */
export type ErrorMessage = {
  type: 'error';
  id: string;
  message: string;
};
