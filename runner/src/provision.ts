/**
 * Container-side runtime provision coordinator.
 *
 * The `provision_runtime` tool calls {@link ProvisionCoordinator.requestProvision} from inside a
 * live SDK turn. That emits a `request_provision` line to the gateway and blocks on a promise.
 * The gateway resolves the runtime name against its catalog and returns `provision_result`.
 */

import type { ProvisionResultMessage } from './protocol.js';
import { RequestCoordinator } from './request-coordinator.js';

export type ProvisionOutcome =
  | { ok: true }
  | { ok: false; error: string };

export interface ProvisionInput {
  name: string;
}

/** Emits a `request_provision` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestProvisionFn = (input: ProvisionInput, id: string) => void;

export class ProvisionCoordinator {
  private readonly base: RequestCoordinator<ProvisionInput, ProvisionResultMessage, ProvisionOutcome>;

  constructor(emitRequest: EmitRequestProvisionFn) {
    this.base = new RequestCoordinator(
      'provision',
      emitRequest,
      (msg) => msg.ok
        ? { ok: true }
        : { ok: false, error: msg.error ?? 'runtime provision failed' },
      { ok: false, error: 'shutting down' },
    );
  }

  requestProvision(input: ProvisionInput): Promise<ProvisionOutcome> {
    return this.base.request(input);
  }

  handleResult(msg: ProvisionResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  failAllPending(): void {
    this.base.failAllPending();
  }
}
