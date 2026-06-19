import type { OneShotBlueprint, OneShotContext, OneShotDeps } from './context.js';
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
  const failing = [ctx.lintResult, ctx.testResult].filter(checkFailed);

  if (failing.length === 0) {
    // All checks passed or were skipped — no retry needed
    return { retry: false };
  }

  const combinedOutput = failing.map((r) => r.output).join('\n');
  const classification = classifyFailure(combinedOutput);

  if (classification === 'transient') {
    return { retry: true, status: 'checks failed (transient) — retrying…' };
  } else {
    return {
      retry: false,
      status: 'checks failed (permanent) — opening PR with failing checks for review',
    };
  }
}

const fixLoop = boundedRetry<OneShotContext, OneShotDeps>(
  [implementNode, lintNode, testNode],
  { name: 'implement-check-loop', maxAttempts: 2, decide },
);

export const repoOneshot: OneShotBlueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, researchNode, planNode, branchNode, fixLoop, pushNode, openPrNode],
};
