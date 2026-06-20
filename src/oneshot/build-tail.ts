import type { OneShotBlueprint } from './context.js';
import { branchNode } from './nodes/branch.js';
import { fixLoop } from './repo-oneshot.js';

export const buildTail: OneShotBlueprint = {
  id: 'build-tail',
  requiresLease: false,
  requiresPassingChecks: true,
  nodes: [branchNode, fixLoop],
};
