/**
 * RealRuntimeProvisionService — catalog-gated runtime provisioning.
 *
 * The model names a runtime only. The gateway resolves it against the injected
 * catalog and delegates the pinned fetch/verify/extract work to the git-node
 * executor. Never throws to the protocol path — outcomes are returned as data.
 */

import type {
  ProvisionOutcome,
  RuntimeCatalogEntry,
  RuntimeProvisionRequest,
  RuntimeProvisionService,
} from '../runner/runtime-provision-service.js';
import type { GitNodeExecutor } from './git-node.js';

export class RealRuntimeProvisionService implements RuntimeProvisionService {
  constructor(
    private readonly gitNodes: GitNodeExecutor,
    private readonly catalog: ReadonlyMap<string, RuntimeCatalogEntry>,
  ) {}

  async provision(req: RuntimeProvisionRequest): Promise<ProvisionOutcome> {
    const entry = this.catalog.get(req.name);
    if (entry === undefined) {
      return { ok: false, error: 'runtime not available' };
    }

    try {
      await this.gitNodes.provisionRuntime({ name: req.name, entry, volume: req.volume });
      return { ok: true };
    } catch {
      return { ok: false, error: 'runtime provision failed' };
    }
  }
}
