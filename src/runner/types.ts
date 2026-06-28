import type { Profile } from '../profiles/registry.js';
import type { RunnerErrorClass } from './protocol.js';

export type ErrorReason = 'timeout' | 'container_exit' | 'runner_error';

export type ProtocolSkipReason = 'json_parse' | 'decision_invalid';

export type RunnerEvent =
  | { type: 'status'; text: string }   // progress note (tool use etc.)
  | { type: 'file'; name: string; data: Buffer }  // file produced during the turn
  | { type: 'text'; text: string }     // final assistant text for this turn
  | { type: 'await_approval'; prompt: string }  // gateway-side gate: pause, post `prompt`, await a reply
  // gateway-internal: the runner's build_spec tool asked the gateway to collect a human decision,
  // but the turn itself continues and ends normally. The manager stores the approval id and routes
  // a later authenticated thread reply back as a new-turn approval control.
  | { type: 'approval_requested'; approvalId: string; prompt: string; specRef: string }
  // gateway-side: a gate deliberately ended the run (cancel/timeout) — NOT an error. Contract:
  // the consumer stops driving the stream on this event (calls `.return()`), which unwinds the
  // run's `finally` blocks (e.g. the orchestrator's lease revoke). It is the terminal counterpart
  // to `await_approval`: that one requires a resume back, this one requires a `.return()`.
  | { type: 'abandoned'; reason: string }
  // gateway-internal: a pull request was successfully opened. The gateway posts the URL to Slack
  // AND records an audit event. NOT a protocol/wire change — this event never crosses the
  // container boundary; it is synthesised by the open-pr node and handled in the drain loop.
  | { type: 'pr_opened'; url: string; repo: string; number: number; headSha: string; correlationId?: string; elapsedMs?: number }
  // gateway-internal: this thread's PR was successfully edited. Audit-only; no Slack post.
  | { type: 'pr_edited'; url: string; elapsedMs?: number }
  // gateway-internal: a comment was successfully added to this thread's PR. Audit-only.
  | { type: 'pr_commented'; url: string; elapsedMs?: number }
  // per-turn cost + tokens, emitted just before the terminal text/error (and on
  // error/abandoned turns too — they still cost). Recorded to the audit ledger;
  // never acted on as control. Does NOT terminate the stream.
  | { type: 'usage'; costMicroUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  // gateway-internal: the coordinator emitted a structured verification decision. Recorded as data
  // in the audit ledger and never acted on as control.
  | { type: 'decision'; point: 'verify'; verdict: 'pass' | 'fail'; rationale: string; correlationId?: string }
  // gateway-internal: the protocol read loop discarded a malformed line (bad JSON or invalid
  // decision fields). Content-free — session key + reason + byte count only. Does NOT terminate
  // the stream; the turn drains normally after the skip. Never crosses the container boundary.
  | { type: 'protocol_skip'; reason: ProtocolSkipReason; bytes: number }
  | { type: 'error'; message: string; reason: ErrorReason; errorClass?: RunnerErrorClass }
  // gateway-internal: the coordinator's build_spec tool asked the gateway to run the build
  // tail (a fresh implementer container on the shared volume). The manager services it and
  // feeds a BuildOutcome back via next(); it never crosses the container boundary as-is.
  // The build always targets the session's shared volume (derived from the session key), so
  // the event carries only the repo — no volume field.
  | { type: 'run_build'; repo: string }
  // gateway-internal: the coordinator's exec tool asked the gateway to run the ungated
  // repo-oneshot blueprint. The manager checks the original requestor's recorded opt-in
  // before creating a one-shot runner, then feeds an ExecOutcome back via next().
  | { type: 'run_exec'; host: ExecHost; repo: string; instruction: string };

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
 * The outcome of a build tail run. Fed back into the coordinator run via
 * `next(buildOutcome)` after `runBuild` completes (symmetric to GateResume for
 * the await_approval gate). Success means the local candidate is ready on the
 * shared volume; publication is an explicit later step. Gateway-internal only.
 */
export type BuildOutcome =
  | { ok: true }
  | { ok: false; reason: string };  // short, token-free

export type ExecHost = 'github' | 'gitlab';

export interface ExecInput {
  host: ExecHost;
  repo: string;
  instruction: string;
}

/**
 * The outcome of an ungated exec run. Fed back into the coordinator run via
 * `next(execOutcome)` after `runExec` completes. Gateway-internal only.
 */
export type ExecOutcome =
  | { ok: true; prUrl?: string }
  | { ok: false; reason: string };

/** A trusted approval verdict that the gateway feeds to the runner before the next user turn. */
export type ApprovalControl = {
  id: string;
  specRef: string;
  approved: boolean;
  feedback?: string;
};

export interface RunnerSendOptions {
  approval?: ApprovalControl;
}

/**
 * A run's event stream. Two-way: the consumer may feed a {@link GateResume} back via
 * `next()` to resume a run parked at an `await_approval` gate, a {@link BuildOutcome}
 * to resume a run parked at a `run_build` event, or an {@link ExecOutcome} to resume
 * a run parked at a `run_exec` event. `TNext` is part of the contract so the resume
 * value can thread (via `yield*`) from the gateway down through the orchestrator and
 * blueprint into the parked node. Non-gate/non-build/non-exec runs never read it.
 */
export type RunnerStream = AsyncGenerator<RunnerEvent, void, GateResume | BuildOutcome | ExecOutcome | undefined>;

export interface SessionRunner {
  /** Send one user message; yields events until the turn completes. */
  send(message: string, opts?: RunnerSendOptions): RunnerStream;
  dispose(): Promise<void>;
}

export interface RunnerFactory {
  create(sessionKey: string, profile: Profile, opts?: { nameSuffix?: string }): Promise<SessionRunner>;
}

/** Builds the one-shot "build tail": a fresh implementer container on the session's shared
 *  volume, wrapped in the build-tail blueprint. Implemented by DispatchingRunnerFactory
 *  (it holds the broker + git nodes); injected into the SessionManager. */
export interface BuildRunnerFactory {
  createBuildRunner(sessionKey: string, repo: string): Promise<SessionRunner>;
  createExecRunner(sessionKey: string, input: ExecInput): Promise<SessionRunner>;
}

/** Removes the Docker volume backing a session. Implemented by the docker factory;
 *  injected into SessionManager for the volume-GC sweep. */
export interface VolumeReaper {
  /** Remove the volume for `sessionKey`. Resolves true when the volume is gone
   *  (removed, or already absent); false on a real failure (e.g. still in use). */
  removeVolumeForSession(sessionKey: string): Promise<boolean>;
}
