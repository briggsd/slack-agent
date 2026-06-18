import type { Blueprint } from './types.js';
import { cloneNode } from './nodes/clone.js';
import { implementNode } from './nodes/implement.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';

export const repoOneshot: Blueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, implementNode, pushNode, openPrNode],
};
