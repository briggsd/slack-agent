/**
 * Generic combinators for the blueprint engine.
 *
 * IMPORTANT: This file must NOT import from src/oneshot/ or src/broker/.
 * The `blueprints-engine-stays-generic` dependency-cruiser rule enforces this.
 * All workflow-specific knowledge (classifiers, check-result reading) lives in
 * the injected `decide` callback and in the workflow's own modules.
 */

import type { RunnerEvent } from '../runner/types.js';
import type { BlueprintNode, NodeKind } from './types.js';

export interface BoundedRetryOptions<Ctx, Deps> {
  readonly name: string;
  /** Total body executions (>=1). 2 = initial + one fix cycle. */
  readonly maxAttempts: number;
  /**
   * Called after each body run EXCEPT the last.
   * `attempt` is 0-based (0 = first run just finished).
   * retry=true → run body again.
   * An optional status string is yielded as a status event if present.
   */
  decide(ctx: Ctx, deps: Deps, attempt: number): Promise<{ retry: boolean; status?: string }>;
}

/**
 * Wraps a sub-sequence of nodes in a bounded retry loop.
 *
 * - Runs the body nodes in order for each attempt.
 * - After each non-final attempt, calls `decide`; if `retry` is false, stops early.
 * - A body node that THROWS propagates out (fatal); only `decide` drives retries.
 * - The combinator's kind is `'agentic'` if any body node is agentic, else `'deterministic'`.
 */
export function boundedRetry<Ctx, Deps>(
  body: readonly BlueprintNode<Ctx, Deps>[],
  opts: BoundedRetryOptions<Ctx, Deps>,
): BlueprintNode<Ctx, Deps> {
  if (opts.maxAttempts < 1) {
    throw new RangeError(`boundedRetry: maxAttempts must be >= 1, got ${String(opts.maxAttempts)}`);
  }
  const kind: NodeKind = body.some((n) => n.kind === 'agentic') ? 'agentic' : 'deterministic';

  return {
    name: opts.name,
    kind,
    async *run(ctx: Ctx, deps: Deps): AsyncGenerator<RunnerEvent> {
      for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
        // Run every body node in order — do NOT catch throws (fatal errors propagate)
        for (const node of body) {
          yield* node.run(ctx, deps);
        }

        // Don't call decide after the final attempt
        if (attempt < opts.maxAttempts - 1) {
          const { retry, status } = await opts.decide(ctx, deps, attempt);
          if (status !== undefined) {
            yield { type: 'status', text: status };
          }
          if (!retry) {
            break;
          }
        }
      }
    },
  };
}
