/**
 * Container-side build coordinator (router; S12b).
 *
 * The `build_spec` tool (phase ②) calls {@link BuildCoordinator.requestBuild} from inside a live
 * SDK turn. That emits a `request_build` line to the gateway and blocks on a promise. The
 * runner's stdin dispatcher routes the gateway's `build_result` back in via
 * {@link BuildCoordinator.handleResult}, which resolves the promise — so the tool returns the
 * outcome (PR URL or failure reason) to the model. The gateway services the build via S12a's
 * engine (it does NOT service it inline — it yields `run_build` up to the manager). The
 * coordinator is pure (no SDK, no stdio of its own): it takes an emit callback and is driven by
 * parsed messages, so it unit-tests offline.
 */

import type { BuildResultMessage } from './protocol.js';

/** The outcome of a build, as the build_spec tool sees it. */
export type BuildOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

/** Emits a `request_build` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestBuildFn = (repo: string, id: string) => void;

export class BuildCoordinator {
  private readonly pending = new Map<string, (outcome: BuildOutcome) => void>();
  private seq = 0;
  /** Set once stdin closes: no result can arrive after this, so new builds resolve immediately. */
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestBuildFn) {}

  /**
   * Request a build: emit `request_build` and resolve when the matching result arrives.
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as a failure.
   */
  requestBuild(repo: string): Promise<BuildOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, reason: 'shutting down' });
    }
    const id = `build-${++this.seq}`;
    return new Promise<BuildOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(repo, id);
    });
  }

  /**
   * Route an inbound `build_result` to its waiting build request. Returns true if it
   * matched a pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: BuildResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: BuildOutcome = msg.ok
      ? { ok: true, prUrl: msg.prUrl ?? '' }
      : { ok: false, reason: msg.reason ?? 'build failed' };
    resolve(outcome);
    return true;
  }

  /**
   * Resolve every still-pending build as failed. Called when stdin closes so a tool parked
   * on a result that will never come can't wedge the process at shutdown.
   */
  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ ok: false, reason: 'shutting down' });
    }
  }
}
