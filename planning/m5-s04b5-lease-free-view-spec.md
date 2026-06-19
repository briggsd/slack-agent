# Task: Lease-free agentic context view (structural "credential never to the sandbox")

Coordinator-authored slice (no implementer hand-off). The S04b hardening item from the S04a factory
review and `design/0004`: split `OneShotContext` so **agentic** nodes get a view that omits the
credential `lease`, making "the credential never enters the sandbox" a *type-level* guarantee rather
than a convention.

## Why

Today every node receives the full `OneShotContext`, which includes `lease: CredentialLease` (the
git token via `lease.token`). No agentic node reads it — but nothing *stops* a future agentic node
from forwarding `ctx.lease.token` into `deps.inner.send(...)`, which would put the credential inside
the agent container (the exact boundary M5's broker exists to protect). Splitting the type so
agentic nodes can't even name `lease` makes the protection structural.

## Design

- `OneShotAgenticContext` — every field of the context **except** `lease`. The agent-facing view.
- `OneShotContext extends OneShotAgenticContext` — adds `readonly lease: CredentialLease`. The full,
  trusted-side view (deterministic credentialed nodes: clone/branch/push/open-pr; lint/test don't use it).
- `OneShotAgenticNode = BlueprintNode<OneShotAgenticContext, OneShotDeps>`. Agentic nodes (research,
  plan, implement) are typed against the view, so their `run(ctx, …)` body cannot reference `ctx.lease`
  (compile error if attempted).
- The blueprint stays `Blueprint<OneShotContext, OneShotDeps>`; the orchestrator still builds a full
  `OneShotContext` (with lease) and `runBlueprint` runs every node with it. Agentic nodes accept it
  because `OneShotContext` is assignable to the view (it has all the view's fields). Mixing
  `OneShotAgenticNode`s into the `OneShotContext` node list / the `boundedRetry` body relies on
  TypeScript method-parameter **bivariance** (`BlueprintNode.run` is a method): a node whose `run`
  takes the wider `OneShotAgenticContext` is assignable where one taking `OneShotContext` is expected.

## Acceptance criteria

1. `npm run gate` passes — **no behavior change**, so every existing test stays green unchanged.
2. `context.ts` defines `OneShotAgenticContext` (no `lease`), `OneShotContext extends OneShotAgenticContext`
   (adds `lease`), and an `OneShotAgenticNode` type alias.
3. `research.ts`, `plan.ts`, `implement.ts` are typed `OneShotAgenticNode` with `run(ctx: OneShotAgenticContext, …)`.
   `agentic-turn.ts` stays usable from them (its `deps` param is unchanged `OneShotDeps`).
4. Deterministic nodes (clone, branch, lint, test, push, open-pr) and the `decide` callback keep the
   full `OneShotContext`.
5. A guard test proving the structure: an agentic-typed node that tries to read `ctx.lease` is a
   **compile error** — pin it with a single `@ts-expect-error` in a test (this is a type assertion, not
   an `@ts-ignore` escape hatch; it FAILS the build if the error ever stops occurring, i.e. if `lease`
   leaks back into the view).

## Out of scope

- Narrowing `OneShotDeps` for agentic nodes (a `gitNodes`-free agentic deps view) — possible follow-up;
  the lease is the credential and lives in the context, so the context split is the structural win here.
- Any change to the orchestrator's context construction or the broker.
