import type { SessionRunner } from '../runner/types.js';
import type { CredentialLease, GitHost } from '../broker/types.js';
import type { GitNodeExecutor, CheckResult } from './git-node.js';
import type { BlueprintNode, Blueprint } from '../blueprints/types.js';

export interface OneShotDeps {
  readonly inner: SessionRunner;       // sandbox runner (agentic nodes only)
  readonly gitNodes: GitNodeExecutor;  // deterministic credentialed git ops
}

/**
 * The lease-free view that AGENTIC nodes (research, plan, implement) see — every
 * field of the context EXCEPT the credential `lease`. Agentic nodes are typed
 * against this so they cannot even name `ctx.lease`: keeping the credential out of
 * the sandbox is a compile-time guarantee, not a convention. (The token lives in
 * `lease.token`; an agentic node with no `lease` in scope cannot forward it into
 * `deps.inner`.)
 */
export interface OneShotAgenticContext {
  readonly host: GitHost;
  readonly repo: string;
  readonly instruction: string;
  readonly taskId: string;
  readonly volume: string;
  readonly workdir: string;
  readonly branch: string;
  // accumulators
  researchSummary?: string;
  planSummary?: string;
  implementSummary?: string;
  lintResult?: CheckResult;
  testResult?: CheckResult;
  prUrl?: string;
}

/**
 * The full context — adds the credential `lease`, seen only by DETERMINISTIC,
 * trusted-side nodes that run credentialed git operations (clone/branch/push/open-pr).
 * The orchestrator builds this; `runBlueprint` runs every node with it. Agentic nodes
 * accept it because it satisfies the lease-free view above.
 */
export interface OneShotContext extends OneShotAgenticContext {
  readonly lease: CredentialLease;
}

export type OneShotNode = BlueprintNode<OneShotContext, OneShotDeps>;
/**
 * An agentic node — receives the lease-free {@link OneShotAgenticContext}. Assignable
 * into a {@link OneShotContext} blueprint/`boundedRetry` body via TypeScript method
 * bivariance (a node whose `run` takes the wider view fits where the full context is
 * expected, and is always called with the full context at runtime).
 */
export type OneShotAgenticNode = BlueprintNode<OneShotAgenticContext, OneShotDeps>;
export type OneShotBlueprint = Blueprint<OneShotContext, OneShotDeps>;

// Compile-time guard for the structural invariant: the agent-facing view must NEVER
// expose the credential `lease`. If `lease` ever leaks back into OneShotAgenticContext
// (e.g. someone merges the two interfaces), the conditional resolves to `never` and this
// assignment fails `tsc` — the build breaks instead of the credential reaching the sandbox.
// (src/ is type-checked by `npm run check`; test/ is not, so this guard lives here.)
const _agenticViewHasNoLease: 'lease' extends keyof OneShotAgenticContext ? never : true = true;
void _agenticViewHasNoLease;
