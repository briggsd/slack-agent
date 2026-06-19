import type { OneShotBlueprint, OneShotContext, OneShotDeps } from './context.js';
import { cloneNode } from './nodes/clone.js';
import { researchNode } from './nodes/research.js';
import { planNode } from './nodes/plan.js';
import { planGateNode } from './nodes/plan-gate.js';
import { branchNode } from './nodes/branch.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';
import { fixLoop } from './repo-oneshot.js';
import { loopUntil } from '../blueprints/combinators.js';

/**
 * Safety backstop only — NOT a functional limit. Real termination is approve / cancel /
 * a 15-min park timeout, all human-driven, so a person never hits this. It exists so a
 * misbehaving driver (one that resumes the gate without ever approving or abandoning)
 * can't loop the planner — and the LLM calls behind it — without bound. On exhaustion the
 * combinator throws, which surfaces as an error event.
 */
const MAX_PLAN_REVISIONS = 25;

/**
 * Supervised one-shot blueprint.
 *
 * Same shape as the unsupervised blueprint, except plan + the approval gate run inside a
 * loop: the human approves, cancels, or sends feedback that triggers a re-plan, and no code
 * is written until they approve. The loop is unbounded — termination comes from the gate
 * (approve sets `planApproved`; cancel/timeout abandons the run). branch → implement → push →
 * open-pr only run after approval.
 */
export const supervisedRepoOneshot: OneShotBlueprint = {
  id: 'supervised-repo-oneshot',
  nodes: [
    cloneNode,
    researchNode,
    loopUntil<OneShotContext, OneShotDeps>([planNode, planGateNode], {
      name: 'plan-approval-loop',
      done: (ctx) => ctx.planApproved === true,
      maxIterations: MAX_PLAN_REVISIONS,
    }),
    branchNode,
    fixLoop,
    pushNode,
    openPrNode,
  ],
};
