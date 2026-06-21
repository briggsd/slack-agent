/**
 * Container-side runtime provision coordinator.
 *
 * The `provision_runtime` tool calls {@link ProvisionCoordinator.requestProvision} from inside a
 * live SDK turn. That emits a `request_provision` line to the gateway and blocks on a promise.
 * The gateway resolves the runtime name against its catalog and returns `provision_result`.
 */

import type { ProvisionResultMessage } from './protocol.js';

export type ProvisionOutcome =
  | { ok: true }
  | { ok: false; error: string };

export interface ProvisionInput {
  name: string;
}

/** Emits a `request_provision` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestProvisionFn = (input: ProvisionInput, id: string) => void;

export class ProvisionCoordinator {
  private readonly pending = new Map<string, (outcome: ProvisionOutcome) => void>();
  private seq = 0;
  private drained = false;

  constructor(private readonly emitRequest: EmitRequestProvisionFn) {}

  requestProvision(input: ProvisionInput): Promise<ProvisionOutcome> {
    if (this.drained) {
      return Promise.resolve({ ok: false, error: 'shutting down' });
    }
    const id = `provision-${++this.seq}`;
    return new Promise<ProvisionOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(input, id);
    });
  }

  handleResult(msg: ProvisionResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    const outcome: ProvisionOutcome = msg.ok
      ? { ok: true }
      : { ok: false, error: msg.error ?? 'runtime provision failed' };
    resolve(outcome);
    return true;
  }

  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ ok: false, error: 'shutting down' });
    }
  }
}
