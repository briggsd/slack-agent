import type { OneShotBlueprint } from './context.js';
import { branchNode } from './nodes/branch.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';
import { fixLoop } from './repo-oneshot.js';

export const buildTail: OneShotBlueprint = {
  id: 'build-tail',
  nodes: [branchNode, fixLoop, pushNode, openPrNode],
};
