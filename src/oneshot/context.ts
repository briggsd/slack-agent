import type { SessionRunner } from '../runner/types.js';
import type { CredentialLease, GitHost } from '../broker/types.js';
import type { GitNodeExecutor, CheckResult } from './git-node.js';
import type { BlueprintNode, Blueprint } from '../blueprints/types.js';

export interface OneShotDeps {
  readonly inner: SessionRunner;       // sandbox runner (agentic nodes only)
  readonly gitNodes: GitNodeExecutor;  // deterministic credentialed git ops
}

export interface OneShotContext {
  readonly host: GitHost;
  readonly repo: string;
  readonly instruction: string;
  readonly taskId: string;
  readonly volume: string;
  readonly workdir: string;
  readonly branch: string;
  readonly lease: CredentialLease;
  // accumulators
  researchSummary?: string;
  planSummary?: string;
  implementSummary?: string;
  lintResult?: CheckResult;
  testResult?: CheckResult;
  prUrl?: string;
}

export type OneShotNode = BlueprintNode<OneShotContext, OneShotDeps>;
export type OneShotBlueprint = Blueprint<OneShotContext, OneShotDeps>;
