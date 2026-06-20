/**
 * Container-side checks coordinator.
 *
 * The `run_checks` tool calls {@link ChecksCoordinator.requestChecks} from inside a live SDK
 * turn. That emits a `request_run_checks` line to the gateway and blocks on a promise. The
 * runner's stdin dispatcher routes the gateway's `run_checks_result` back in via
 * {@link ChecksCoordinator.handleResult}, which resolves the promise.
 */

import type { RunChecksKind, RunChecksResult, RunChecksResultMessage } from './protocol.js';

/** The outcome of run_checks, as the tool sees it. */
export type ChecksOutcome =
  | { ok: true; results: RunChecksResult[] }
  | { ok: false; reason: string };

export interface ChecksInput {
  repo: string;
  kind?: RunChecksKind;
}

/** Emits a `request_run_checks` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestChecksFn = (input: ChecksInput, id: string) => void;

export class ChecksCoordinator {
  private readonly pending = new Map<string, (outcome: ChecksOutcome) => void>();
  private seq = 0;
  /** Set once stdin closes: no result can arrive after this, so new requests resolve immediately. */
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestChecksFn) {}

  /**
   * Request checks: emit `request_run_checks` and resolve when the matching result arrives.
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as a failure.
   */
  requestChecks(input: ChecksInput): Promise<ChecksOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, reason: 'shutting down' });
    }
    const id = `checks-${++this.seq}`;
    const normalized: ChecksInput = { repo: input.repo, kind: input.kind ?? 'all' };
    return new Promise<ChecksOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(normalized, id);
    });
  }

  /**
   * Route an inbound `run_checks_result` to its waiting request. Returns true if it matched a
   * pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: RunChecksResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: ChecksOutcome = msg.ok
      ? { ok: true, results: msg.results ?? [] }
      : { ok: false, reason: msg.reason ?? 'run checks failed' };
    resolve(outcome);
    return true;
  }

  /**
   * Resolve every still-pending checks request as failed. Called when stdin closes so a tool
   * parked on a result that will never come can't wedge the process at shutdown.
   */
  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ ok: false, reason: 'shutting down' });
    }
  }
}
