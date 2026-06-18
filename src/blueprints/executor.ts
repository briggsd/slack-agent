import type { RunnerEvent } from '../runner/types.js';
import type { Blueprint } from './types.js';

export async function* runBlueprint<Ctx, Deps>(
  blueprint: Blueprint<Ctx, Deps>,
  ctx: Ctx,
  deps: Deps,
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
