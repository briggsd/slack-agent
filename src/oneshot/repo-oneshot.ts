import type { OneShotBlueprint, OneShotContext, OneShotDeps } from './context.js';
import type { CheckResult } from './git-node.js';
import { cloneNode } from './nodes/clone.js';
import { researchNode } from './nodes/research.js';
import { planNode } from './nodes/plan.js';
import { branchNode } from './nodes/branch.js';
import { implementNode } from './nodes/implement.js';
import { lintNode } from './nodes/lint.js';
import { testNode } from './nodes/test.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';
import { boundedRetry } from '../blueprints/combinators.js';
import { checkFailed, classifyFailure } from './classify.js';

async function decide(
  ctx: OneShotContext,
  _deps: OneShotDeps,
  _attempt: number,
): Promise<{ retry: boolean; status?: string }> {
  const failing = failingChecks(ctx);

  if (failing.length === 0) {
    // All checks passed or were skipped — no retry needed
    return { retry: false };
  }

  const combinedOutput = failing.map((r) => r.output).join('\n');
  const classification = classifyFailure(combinedOutput);

  if (classification === 'transient') {
    return { retry: true, status: 'checks failed (transient) — retrying…' };
  } else {
    if (ctx.requiresPassingChecks === true) {
      return {
        retry: false,
        status: 'checks failed (permanent) — local candidate not ready',
      };
    }
    return {
      retry: false,
      status: 'checks failed (permanent) — opening PR with failing checks for review',
    };
  }
}

function failingChecks(ctx: OneShotContext): CheckResult[] {
  return [ctx.lintResult, ctx.testResult].filter(checkFailed);
}

async function finish(ctx: OneShotContext, _deps: OneShotDeps): Promise<{ status?: string }> {
  if (ctx.requiresPassingChecks === true && failingChecks(ctx).length > 0) {
    throw new Error('build checks failed after retries');
  }
  return {};
}

/** The implement → lint → test cycle with bounded retry. Shared with the supervised blueprint. */
export const fixLoop = boundedRetry<OneShotContext, OneShotDeps>(
  [implementNode, lintNode, testNode],
  { name: 'implement-check-loop', maxAttempts: 2, decide, finish },
);

export const repoOneshot: OneShotBlueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, researchNode, planNode, branchNode, fixLoop, pushNode, openPrNode],
};
