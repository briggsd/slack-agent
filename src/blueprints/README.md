# `src/blueprints/` — generic workflow engine

Two small files. A workflow defines its own context and deps types, writes nodes against them, and runs them through here.

## What it is

A `Blueprint<Ctx, Deps>` is an ordered list of `BlueprintNode<Ctx, Deps>` values. `runBlueprint` iterates them in order, forwarding each node's `RunnerEvent` stream to the caller. That is the whole engine.

## The contract

```ts
interface BlueprintNode<Ctx, Deps> {
  readonly name: string;
  readonly kind: NodeKind;           // 'deterministic' | 'agentic'
  run(ctx: Ctx, deps: Deps): AsyncIterable<RunnerEvent>;
}

interface Blueprint<Ctx, Deps> {
  readonly id: string;
  readonly nodes: readonly BlueprintNode<Ctx, Deps>[];
}
```

Nodes read and write a shared `ctx` object. A node that throws stops the run: the executor catches the error, yields a single `{ type: 'error', message }` event, and returns without re-throwing. Later nodes do not run.

## `deterministic` vs `agentic` (`NodeKind`)

`agentic` nodes delegate work to a sandbox `SessionRunner` (received via `deps`). The engine itself never runs agent code — that boundary is the container. `deterministic` nodes do trusted-side work (git operations, API calls) without touching the agent.

## How to build a workflow on it

1. Define your `Ctx` and `Deps` types.
2. Write nodes typed as `BlueprintNode<Ctx, Deps>`.
3. Compose a `Blueprint<Ctx, Deps>` (just an `id` + `nodes` array).
4. Run it: `for await (const ev of runBlueprint(blueprint, ctx, deps)) { ... }`.

The worked example is `src/oneshot/`: `context.ts` (types), `nodes/` (four nodes), `repo-oneshot.ts` (the blueprint), `registry.ts` (lookup by id), `orchestrator.ts` (drives the whole flow including lease lifecycle).

## What the engine deliberately does NOT know

Git, credentials/leases, Slack, profiles. Those live in the workflow layer. This separation is enforced by the `blueprints-engine-stays-generic` dependency-cruiser rule, which forbids `src/blueprints/` from importing `src/oneshot/` or `src/broker/`.
