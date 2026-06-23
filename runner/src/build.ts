/**
 * Container-side build coordinator (router; S12b).
 *
 * The `build_spec` tool (phase ②) calls {@link BuildCoordinator.requestBuild} from inside a live
 * SDK turn. That emits a `request_build` line to the gateway and blocks on a promise. The
 * runner's stdin dispatcher routes the gateway's `build_result` back in via
 * {@link BuildCoordinator.handleResult}, which resolves the promise — so the tool returns the
 * outcome (candidate-ready success or failure reason) to the model. The gateway services the build via S12a's
 * engine (it does NOT service it inline — it yields `run_build` up to the manager). The
 * coordinator is pure (no SDK, no stdio of its own): it takes an emit callback and is driven by
 * parsed messages, so it unit-tests offline.
 */

import type { BuildResultMessage } from './protocol.js';
import { RequestCoordinator } from './request-coordinator.js';

/** The outcome of a build, as the build_spec tool sees it. */
export type BuildOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/** Emits a `request_build` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestBuildFn = (repo: string, id: string) => void;

export class BuildCoordinator {
  private readonly base: RequestCoordinator<string, BuildResultMessage, BuildOutcome>;

  constructor(emitRequest: EmitRequestBuildFn) {
    this.base = new RequestCoordinator(
      'build',
      emitRequest,
      (msg) => msg.ok
        ? { ok: true }
        : { ok: false, reason: msg.reason ?? 'build failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  /**
   * Request a build: emit `request_build` and resolve when the matching result arrives.
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as a failure.
   */
  requestBuild(repo: string): Promise<BuildOutcome> {
    return this.base.request(repo);
  }

  /**
   * Route an inbound `build_result` to its waiting build request. Returns true if it
   * matched a pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: BuildResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  /**
   * Resolve every still-pending build as failed. Called when stdin closes so a tool parked
   * on a result that will never come can't wedge the process at shutdown.
   */
  failAllPending(): void {
    this.base.failAllPending();
  }
}
