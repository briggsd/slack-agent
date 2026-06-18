import type { RunnerEvent, SessionRunner } from '../../runner/types.js';
import type { CredentialLease, GitHost } from '../../broker/types.js';
import type { GitNodeExecutor } from '../git-node.js';

export type NodeKind = 'deterministic' | 'agentic';

/** Dependencies a node may use. Only 'agentic' nodes may touch `inner`. */
export interface NodeDeps {
  readonly inner: SessionRunner;       // the sandbox runner (agentic nodes only)
  readonly gitNodes: GitNodeExecutor;  // deterministic credentialed git ops
}

/** Shared state threaded through a blueprint's nodes. Inputs are readonly;
 *  accumulators are filled by nodes as the blueprint runs. */
export interface BlueprintContext {
  readonly host: GitHost;
  readonly repo: string;
  readonly instruction: string;
  readonly taskId: string;
  readonly volume: string;
  readonly workdir: string;
  readonly branch: string;
  readonly lease: CredentialLease;
  // accumulators
  implementSummary?: string;
  prUrl?: string;
}

export interface BlueprintNode {
  readonly name: string;
  readonly kind: NodeKind;
  /** Yields events; reads and writes ctx. Throwing aborts the blueprint (the
   *  executor turns it into a single error event + teardown). */
  run(ctx: BlueprintContext, deps: NodeDeps): AsyncIterable<RunnerEvent>;
}

export interface Blueprint {
  readonly id: string;
  readonly nodes: readonly BlueprintNode[];
}
