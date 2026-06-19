import type { OneShotBlueprint } from './context.js';
import { repoOneshot } from './repo-oneshot.js';

/**
 * Supervised one-shot blueprint.
 *
 * The node list is a copy of the unsupervised blueprint's until S03 inserts the
 * `plan-gate` node after `planNode`. We copy (rather than share the reference) so
 * that future divergence can't mutate the unsupervised blueprint's `nodes`.
 */
export const supervisedRepoOneshot: OneShotBlueprint = {
  id: 'supervised-repo-oneshot',
  nodes: [...repoOneshot.nodes],
};
