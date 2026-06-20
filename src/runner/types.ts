import type { Profile } from '../profiles/registry.js';

export type RunnerEvent =
  | { type: 'status'; text: string }   // progress note (tool use etc.)
  | { type: 'file'; name: string; data: Buffer }  // file produced during the turn
  | { type: 'text'; text: string }     // final assistant text for this turn
  | { type: 'await_approval'; prompt: string }  // gateway-side gate: pause, post `prompt`, await a reply
  // gateway-side: a gate deliberately ended the run (cancel/timeout) — NOT an error. Contract:
  // the consumer stops driving the stream on this event (calls `.return()`), which unwinds the
  // run's `finally` blocks (e.g. the orchestrator's lease revoke). It is the terminal counterpart
  // to `await_approval`: that one requires a resume back, this one requires a `.return()`.
  | { type: 'abandoned'; reason: string }
  // gateway-internal: a pull request was successfully opened. The gateway posts the URL to Slack
  // AND records an audit event. NOT a protocol/wire change — this event never crosses the
  // container boundary; it is synthesised by the open-pr node and handled in the drain loop.
  | { type: 'pr_opened'; url: string }
  // per-turn cost + tokens, emitted just before the terminal text/error (and on
  // error/abandoned turns too — they still cost). Recorded to the audit ledger;
  // never acted on as control. Does NOT terminate the stream.
  | { type: 'usage'; costMicroUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { type: 'error'; message: string };

/**
 * The value the gateway feeds back into a run parked at an `await_approval` gate
 * (via `iterator.next(resume)`). `reply` carries the user's thread message; `timeout`
 * means no reply arrived within the gate window. Only a gate node reads it; every
 * other yield ignores the resume value (its `next()` is called with `undefined`).
 */
export type GateResume =
  | { kind: 'reply'; text: string }
  | { kind: 'timeout' };

/**
 * A run's event stream. Two-way: the consumer may feed a {@link GateResume} back via
 * `next()` to resume a run parked at an `await_approval` gate. `TNext` is part of the
 * contract so the resume value can thread (via `yield*`) from the gateway down through
 * the orchestrator and blueprint into the parked node. Non-gate runs never read it.
 */
export type RunnerStream = AsyncGenerator<RunnerEvent, void, GateResume | undefined>;

export interface SessionRunner {
  /** Send one user message; yields events until the turn completes. */
  send(message: string): RunnerStream;
  dispose(): Promise<void>;
}

export interface RunnerFactory {
  create(sessionKey: string, profile: Profile): Promise<SessionRunner>;
}

/** Removes the Docker volume backing a session. Implemented by the docker factory;
 *  injected into SessionManager for the volume-GC sweep. */
export interface VolumeReaper {
  /** Remove the volume for `sessionKey`. Resolves true when the volume is gone
   *  (removed, or already absent); false on a real failure (e.g. still in use). */
  removeVolumeForSession(sessionKey: string): Promise<boolean>;
}
