import type { OneShotBlueprint } from './context.js';
import { repoOneshot } from './repo-oneshot.js';
import { supervisedRepoOneshot } from './supervised-repo-oneshot.js';

/**
 * Look up the blueprint for a given profile id.
 * Throws if no blueprint is registered for the given id.
 */
const BLUEPRINTS: readonly OneShotBlueprint[] = [repoOneshot, supervisedRepoOneshot];

export function blueprintFor(blueprintId: string): OneShotBlueprint {
  const blueprint = BLUEPRINTS.find((b) => b.id === blueprintId);
  if (blueprint === undefined) {
    throw new Error(`no blueprint for id "${blueprintId}"`);
  }
  return blueprint;
}
