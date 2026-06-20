/**
 * Container-side publish coordinator.
 *
 * The `publish`/`open_pr` tools call {@link PublishCoordinator.requestPublish} from inside a
 * live SDK turn. That emits a `request_publish` line to the gateway and blocks on a promise.
 * The runner's stdin dispatcher routes the gateway's `publish_result` back in via
 * {@link PublishCoordinator.handleResult}, which resolves the promise.
 */

import type { PublishResultMessage } from './protocol.js';

/** The outcome of publishing, as the publish tool sees it. */
export type PublishOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

export interface PublishInput {
  repo: string;
  title?: string;
  body?: string;
}

/** Emits a `request_publish` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestPublishFn = (input: PublishInput, id: string) => void;

export class PublishCoordinator {
  private readonly pending = new Map<string, (outcome: PublishOutcome) => void>();
  private seq = 0;
  /** Set once stdin closes: no result can arrive after this, so new publishes resolve immediately. */
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestPublishFn) {}

  /**
   * Request publication: emit `request_publish` and resolve when the matching result arrives.
   * Once {@link failAllPending} has drained (stdin closed), resolve immediately as a failure.
   */
  requestPublish(input: PublishInput): Promise<PublishOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, reason: 'shutting down' });
    }
    const id = `publish-${++this.seq}`;
    return new Promise<PublishOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(input, id);
    });
  }

  /**
   * Route an inbound `publish_result` to its waiting publish request. Returns true if it
   * matched a pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: PublishResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: PublishOutcome = msg.ok
      ? { ok: true, prUrl: msg.prUrl ?? '' }
      : { ok: false, reason: msg.reason ?? 'publish failed' };
    resolve(outcome);
    return true;
  }

  /**
   * Resolve every still-pending publish as failed. Called when stdin closes so a tool parked
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
