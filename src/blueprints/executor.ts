import type { RunnerEvent, RunnerStream } from '../runner/types.js';
import type { Blueprint } from './types.js';

export async function* runBlueprint<Ctx, Deps>(
  blueprint: Blueprint<Ctx, Deps>,
  ctx: Ctx,
  deps: Deps,
): RunnerStream {
  for (const node of blueprint.nodes) {
    try {
      // `yield*` (not `for await`) so a resume value fed in via `next()` — the reply
      // to an `await_approval` gate — is forwarded into the node that yielded it. A
      // throw from the node still propagates here and becomes one error event.
      yield* node.run(ctx, deps);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message } satisfies RunnerEvent;
      return;
    }
  }
}
