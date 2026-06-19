import type { Profile } from '../profiles/registry.js';

export type RunnerEvent =
  | { type: 'status'; text: string }   // progress note (tool use etc.)
  | { type: 'file'; name: string; data: Buffer }  // file produced during the turn
  | { type: 'text'; text: string }     // final assistant text for this turn
  | { type: 'await_approval'; prompt: string }  // gateway-side gate: pause, post `prompt`, await a reply
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
