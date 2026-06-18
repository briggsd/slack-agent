/**
 * runBlueprint — pure sequencer for a Blueprint's nodes.
 *
 * Runs nodes in order, forwarding each node's events. On any node throw,
 * yields a single error event and stops (later nodes do not run). Does not
 * own the lease — revocation stays in the orchestrator's finally guard.
 */

import type { RunnerEvent } from '../runner/types.js';
import type { Blueprint, BlueprintContext, NodeDeps } from './blueprints/types.js';

export async function* runBlueprint(
  blueprint: Blueprint,
  ctx: BlueprintContext,
  deps: NodeDeps,
): AsyncGenerator<RunnerEvent> {
  for (const node of blueprint.nodes) {
    try {
      for await (const ev of node.run(ctx, deps)) {
        yield ev;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message } satisfies RunnerEvent;
      return;
    }
  }
}
