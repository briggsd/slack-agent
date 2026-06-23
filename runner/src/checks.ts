/**
 * Container-side checks coordinator.
 *
 * The `run_checks` tool calls {@link ChecksCoordinator.requestChecks} from inside a live SDK
 * turn. That emits a `request_run_checks` line to the gateway and blocks on a promise. The
 * runner's stdin dispatcher routes the gateway's `run_checks_result` back in via
 * {@link ChecksCoordinator.handleResult}, which resolves the promise.
 */

import type { RunChecksKind, RunChecksResult, RunChecksResultMessage } from './protocol.js';
import { RequestCoordinator } from './request-coordinator.js';

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
  private readonly base: RequestCoordinator<ChecksInput, RunChecksResultMessage, ChecksOutcome>;

  constructor(emitRequest: EmitRequestChecksFn) {
    this.base = new RequestCoordinator(
      'checks',
      emitRequest,
      (msg) => msg.ok
        ? { ok: true, results: msg.results ?? [] }
        : { ok: false, reason: msg.reason ?? 'run checks failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  /**
   * Request checks: emit `request_run_checks` and resolve when the matching result arrives.
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as a failure.
   */
  requestChecks(input: ChecksInput): Promise<ChecksOutcome> {
    const normalized: ChecksInput = { repo: input.repo, kind: input.kind ?? 'all' };
    return this.base.request(normalized);
  }

  /**
   * Route an inbound `run_checks_result` to its waiting request. Returns true if it matched a
   * pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: RunChecksResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  /**
   * Resolve every still-pending checks request as failed. Called when stdin closes so a tool
   * parked on a result that will never come can't wedge the process at shutdown.
   */
  failAllPending(): void {
    this.base.failAllPending();
  }
}
