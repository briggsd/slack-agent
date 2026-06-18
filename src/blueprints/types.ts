import type { RunnerEvent } from '../runner/types.js';

/** A node either runs trusted-side deterministic work, or delegates to a sandbox
 *  agent runner. Only 'agentic' nodes touch the agent — the engine itself runs no
 *  agent code. The concrete deps a node receives are the workflow's `Deps` type. */
export type NodeKind = 'deterministic' | 'agentic';

/** A unit of work in a blueprint, generic over the workflow's context and deps.
 *  Yields RunnerEvents; reads/writes ctx. Throwing aborts the blueprint (the
 *  executor turns it into a single error event). */
export interface BlueprintNode<Ctx, Deps> {
  readonly name: string;
  readonly kind: NodeKind;
  run(ctx: Ctx, deps: Deps): AsyncIterable<RunnerEvent>;
}

/** An ordered list of nodes that share one Ctx/Deps. */
export interface Blueprint<Ctx, Deps> {
  readonly id: string;
  readonly nodes: readonly BlueprintNode<Ctx, Deps>[];
}
