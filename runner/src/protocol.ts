/**
 * Local copy of the gateway protocol types for use inside the runner container.
 *
 * Kept in sync with src/runner/protocol.ts in the gateway package.
 * The runner cannot import from the gateway at container build time, so
 * the shapes are duplicated here verbatim.
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

/** Per-message failure. The runner remains usable after an error. */
export type ErrorMessage = {
  type: 'error';
  id: string;
  message: string;
};
