/**
 * Container-side exec coordinator.
 *
 * The `exec` tool calls {@link ExecCoordinator.requestExec} from inside a live SDK turn.
 * That emits a `request_exec` line to the gateway and blocks on a promise. The gateway
 * owns the authorization decision and either runs the unsupervised one-shot blueprint or
 * returns a refusal as data via `exec_result`.
 */

import type { ExecResultMessage } from './protocol.js';

export type ExecHost = 'github' | 'gitlab';

/** The outcome of exec, as the tool sees it. */
export type ExecOutcome =
  | { ok: true; prUrl?: string }
  | { ok: false; reason: string };

export interface ExecInput {
  host: ExecHost;
  repo: string;
  instruction: string;
}

/** Emits a `request_exec` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestExecFn = (input: ExecInput, id: string) => void;

export class ExecCoordinator {
  private readonly pending = new Map<string, (outcome: ExecOutcome) => void>();
  private seq = 0;
  /** Set once stdin closes: no result can arrive after this, so new execs resolve immediately. */
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestExecFn) {}

  /**
   * Request unsupervised execution: emit `request_exec` and resolve when the matching
   * result arrives. Once {@link failAllPending} has drained, resolve immediately as failure.
   */
  requestExec(input: ExecInput): Promise<ExecOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, reason: 'shutting down' });
    }
    const id = `exec-${++this.seq}`;
    return new Promise<ExecOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(input, id);
    });
  }

  /**
   * Route an inbound `exec_result` to its waiting request. Returns true if it matched
   * a pending request, false for an unknown or already-settled id.
   */
  handleResult(msg: ExecResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: ExecOutcome = msg.ok
      ? (msg.prUrl !== undefined ? { ok: true, prUrl: msg.prUrl } : { ok: true })
      : { ok: false, reason: msg.reason ?? 'exec failed' };
    resolve(outcome);
    return true;
  }

  /**
   * Resolve every still-pending exec as failed. Called when stdin closes so a tool
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
