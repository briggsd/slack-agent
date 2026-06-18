import type { OneShotBlueprint } from './context.js';
import { cloneNode } from './nodes/clone.js';
import { implementNode } from './nodes/implement.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';

export const repoOneshot: OneShotBlueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, implementNode, pushNode, openPrNode],
};
