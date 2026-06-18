import type { OneShotBlueprint } from './context.js';
import { cloneNode } from './nodes/clone.js';
import { researchNode } from './nodes/research.js';
import { planNode } from './nodes/plan.js';
import { branchNode } from './nodes/branch.js';
import { implementNode } from './nodes/implement.js';
import { lintNode } from './nodes/lint.js';
import { testNode } from './nodes/test.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';

export const repoOneshot: OneShotBlueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, researchNode, planNode, branchNode, implementNode, lintNode, testNode, pushNode, openPrNode],
};
