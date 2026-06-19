# `src/blueprints/` — generic workflow engine

A small engine. A workflow defines its own context and deps types, writes nodes against them, and runs them through here. The core is `types.ts` (the contract) and `executor.ts` (the runner); `combinators.ts` adds reusable control-flow nodes (see Combinators below).

## What it is

A `Blueprint<Ctx, Deps>` is an ordered list of `BlueprintNode<Ctx, Deps>` values. `runBlueprint` iterates them in order, forwarding each node's `RunnerEvent` stream to the caller. That is the whole engine.

## The contract

```ts
interface BlueprintNode<Ctx, Deps> {
  readonly name: string;
  readonly kind: NodeKind;           // 'deterministic' | 'agentic'
  run(ctx: Ctx, deps: Deps): RunnerStream;
}

interface Blueprint<Ctx, Deps> {
  readonly id: string;
  readonly nodes: readonly BlueprintNode<Ctx, Deps>[];
}
```

Nodes read and write a shared `ctx` object. A node that throws stops the run: the executor catches the error, yields a single `{ type: 'error', message }` event, and returns without re-throwing. Later nodes do not run.

`RunnerStream` (`AsyncGenerator<RunnerEvent, void, GateResume | undefined>`) is **two-way**: a node may `yield` an `await_approval` event and read back a resume value (the user's reply, or a timeout) — `const resume = yield { type: 'await_approval', prompt }`. The executor delegates with `yield*`, so the value the gateway feeds in via `next()` reaches the node that yielded. A node that never yields `await_approval` simply ignores the resume value. The gateway posts the prompt and routes the reply; the engine knows nothing about the gate beyond forwarding.

## `deterministic` vs `agentic` (`NodeKind`)

`agentic` nodes delegate work to a sandbox `SessionRunner` (received via `deps`). The engine itself never runs agent code — that boundary is the container. `deterministic` nodes do trusted-side work (git operations, API calls) without touching the agent.

## Combinators (`combinators.ts`)

Control flow beyond a straight list is a **combinator** — a node that wraps other nodes. It stays generic over `Ctx`/`Deps`; any workflow-specific decision is supplied as an injected callback, so the engine keeps knowing nothing about the workflow.

`boundedRetry(body, { name, maxAttempts, decide })` runs a sub-sequence of nodes up to `maxAttempts` times. After each non-final attempt it calls `decide(ctx, deps, attempt)`; a truthy `retry` runs the body again (an optional `status` is yielded between cycles), otherwise it stops. A body node that **throws** propagates out (fatal) — only `decide` drives retries, so the retry condition is data the workflow reads from `ctx`, never a caught exception. `maxAttempts < 1` throws. The one-shot blueprint uses it to wrap `implement → lint → test`: `decide` reads the captured check results and retries a transient failure (see `src/oneshot/classify.ts`).

## How to build a workflow on it

1. Define your `Ctx` and `Deps` types.
2. Write nodes typed as `BlueprintNode<Ctx, Deps>`.
3. Compose a `Blueprint<Ctx, Deps>` (just an `id` + `nodes` array).
4. Run it: `for await (const ev of runBlueprint(blueprint, ctx, deps)) { ... }`.

The worked example is `src/oneshot/`: `context.ts` (types), `nodes/` (clone, research, plan, branch, implement, lint, test, push, open-pr), `repo-oneshot.ts` (the blueprint — wrapping implement/lint/test in a `boundedRetry`), `classify.ts` (the retry decision's failure classifier), `registry.ts` (lookup by id), `orchestrator.ts` (drives the whole flow including lease lifecycle).

## What the engine deliberately does NOT know

Git, credentials/leases, Slack, profiles. Those live in the workflow layer. This separation is enforced by the `blueprints-engine-stays-generic` dependency-cruiser rule, which forbids `src/blueprints/` from importing `src/oneshot/` or `src/broker/`.
