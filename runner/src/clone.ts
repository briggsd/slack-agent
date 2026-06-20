/**
 * Container-side clone coordinator (router; S11).
 *
 * The `clone_repo` tool calls {@link CloneCoordinator.requestClone} from inside a live
 * SDK turn. That emits a `request_clone` line to the gateway and blocks on a promise.
 * The runner's stdin dispatcher routes the gateway's `clone_result` back in via
 * {@link CloneCoordinator.handleResult}, which resolves the promise — so the tool
 * returns the local path (or error) to the model. The gateway services the clone inline
 * (no human hop). The coordinator is pure (no SDK, no stdio of its own): it takes an
 * emit callback and is driven by parsed messages, so it unit-tests offline.
 */

import type { CloneResultMessage } from './protocol.js';

/** The outcome of a clone, as the tool sees it. */
export type CloneOutcome =
  | { ok: true; workdir: string }
  | { ok: false; error: string };

/** Emits a `request_clone` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestCloneFn = (repo: string, id: string) => void;

export class CloneCoordinator {
  private readonly pending = new Map<string, (outcome: CloneOutcome) => void>();
  private seq = 0;
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestCloneFn) {}

  /**
   * Request a clone: emit `request_clone` and resolve when the matching result arrives.
   * Once drained (stdin closed), resolves immediately as a failure.
   */
  requestClone(repo: string): Promise<CloneOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, error: 'shutting down' });
    }
    const id = `clone-${++this.seq}`;
    return new Promise<CloneOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(repo, id);
    });
  }

  /**
   * Route an inbound `clone_result` to its waiting clone request. Returns true if it
   * matched a pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: CloneResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: CloneOutcome = msg.ok
      ? { ok: true, workdir: msg.workdir ?? '/workspace' }
      : { ok: false, error: msg.error ?? 'clone failed' };
    resolve(outcome);
    return true;
  }

  /**
   * Resolve every still-pending clone as failed. Called when stdin closes.
   */
  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ ok: false, error: 'shutting down' });
    }
  }
}
