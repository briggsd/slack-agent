# Task: Decouple the blueprint engine from one-shot — promote it to a generic top-level `src/blueprints/`

You are implementing one slice in this checkout (a git worktree of `slack-agent`:
TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(the gate, invariants, conventions), then this spec. You are on branch
`sonnet/m5-blueprints-decouple`. **Do NOT edit this spec file.**

## What this slice delivers

S04a put the blueprint framework under `src/oneshot/blueprints/`, which couples the
generic engine to one-shot. This slice **promotes the engine to a generic, top-level
`src/blueprints/`** parameterized over the workflow's context/deps types, and leaves the
one-shot-specific pieces (nodes, context, blueprint, registry) in `src/oneshot/`
consuming it. A future agent workflow can then reuse the engine with its own context
without touching `oneshot/`. Pure refactor — **no behavior change.**

The split is by **dependency direction**, not just folders:
- **Generic engine** (`src/blueprints/`): `BlueprintNode<Ctx, Deps>`, `Blueprint<Ctx,
  Deps>`, `runBlueprint`, `NodeKind`. Knows only the gateway's `RunnerEvent` stream.
  Must NOT import `oneshot/`, `broker/`, or anything git/credential-specific.
- **One-shot's workflow** (`src/oneshot/`): `OneShotContext`/`OneShotDeps` (carry the
  lease, workdir, branch, `gitNodes`, `inner`), the four nodes (clone/implement/push/
  open-pr), the `repoOneshot` blueprint, and `blueprintFor`. These import the git/broker
  seams — they are git-specific and stay with one-shot.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until everything is moved, the boundary rule + README
are added, the new tests pass, and the gate is green. Make every edit, run the gate, fix
failures, then stop. Yielding after only exploring is a failure.

## Context — the current code (you are MOVING + generifying it)

Current `src/oneshot/blueprints/` (read all of it):
- `types.ts` — `NodeKind = 'deterministic' | 'agentic'`; `NodeDeps {inner: SessionRunner;
  gitNodes: GitNodeExecutor}`; `BlueprintContext {host, repo, instruction, taskId, volume,
  workdir, branch, lease; implementSummary?; prUrl?}`; `BlueprintNode {name; kind; run(ctx,
  deps): AsyncIterable<RunnerEvent>}`; `Blueprint {id; nodes: readonly BlueprintNode[]}`.
- `executor.ts` — `runBlueprint(blueprint, ctx, deps): AsyncGenerator<RunnerEvent>` — runs
  nodes in order, forwards events, a node throw → one `error` event + return (no re-throw).
- `nodes/{clone,implement,push,open-pr}.ts` — the four nodes (import `BlueprintNode,
  BlueprintContext, NodeDeps` from `../types.js` and `RunnerEvent` from `../../../runner/types.js`).
- `repo-oneshot.ts` — `repoOneshot: Blueprint = {id:'repo-oneshot', nodes:[clone, implement, push, open-pr]}`.
- `registry.ts` — `blueprintFor(id): Blueprint` — `BLUEPRINTS.find(b => b.id === id)`, throws on miss.

Consumers:
- `src/oneshot/orchestrator.ts` — imports `runBlueprint` from `./executor.js`, `blueprintFor`
  from `./blueprints/registry.js`, `BlueprintContext, NodeDeps` from `./blueprints/types.js`;
  builds `ctx`/`deps` and runs `runBlueprint(blueprintFor(REPO_ONESHOT_PROFILE_ID), ctx, deps)`.
  (Today it imports executor from `./executor.js` — verify the actual path and fix it.)
- `test/oneshot.test.ts` — tests through `OneShotOrchestrator`; does NOT import blueprint
  internals. **It must stay green with ZERO edits.**
- `test/blueprint.test.ts` — imports `runBlueprint`, `blueprintFor`, `repoOneshot`, and the
  `BlueprintNode/BlueprintContext/NodeDeps/Blueprint` types from `../src/oneshot/blueprints/...`.
  These paths move — this file WILL change (see Tests).

## Implementation

### 1. Engine → `src/blueprints/` (generic)
Create `src/blueprints/types.ts`:
```ts
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
```
Create `src/blueprints/executor.ts` — the same logic, generified:
```ts
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
```
The engine must import ONLY from `../runner/types.js`. No git/broker/oneshot imports.

### 2. One-shot's pieces → `src/oneshot/` (consume the engine)
**Delete the `src/oneshot/blueprints/` directory** and relocate as follows:
- `src/oneshot/context.ts` — the one-shot context + deps + type aliases:
  ```ts
  import type { SessionRunner } from '../runner/types.js';
  import type { CredentialLease, GitHost } from '../broker/types.js';
  import type { GitNodeExecutor } from './git-node.js';
  import type { BlueprintNode, Blueprint } from '../blueprints/types.js';

  export interface OneShotDeps {
    readonly inner: SessionRunner;       // sandbox runner (agentic nodes only)
    readonly gitNodes: GitNodeExecutor;  // deterministic credentialed git ops
  }
  export interface OneShotContext {
    readonly host: GitHost;
    readonly repo: string;
    readonly instruction: string;
    readonly taskId: string;
    readonly volume: string;
    readonly workdir: string;
    readonly branch: string;
    readonly lease: CredentialLease;
    implementSummary?: string;
    prUrl?: string;
  }
  export type OneShotNode = BlueprintNode<OneShotContext, OneShotDeps>;
  export type OneShotBlueprint = Blueprint<OneShotContext, OneShotDeps>;
  ```
- `src/oneshot/nodes/{clone,implement,push,open-pr}.ts` — move the four node files here.
  Each: `import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';`
  and `import type { RunnerEvent } from '../../runner/types.js';`. Type the export as
  `export const cloneNode: OneShotNode = { name, kind, async *run(ctx: OneShotContext, deps:
  OneShotDeps) {...} }`. **Body logic unchanged** (clone/implement/push/open-pr verbatim).
- `src/oneshot/repo-oneshot.ts` — `export const repoOneshot: OneShotBlueprint = { id:
  'repo-oneshot', nodes: [cloneNode, implementNode, pushNode, openPrNode] };` (import the
  nodes from `./nodes/...`, `OneShotBlueprint` from `./context.js`).
- `src/oneshot/registry.ts` — `blueprintFor(id): OneShotBlueprint` (same `BLUEPRINTS.find`
  logic; import `repoOneshot` + `OneShotBlueprint`). NOTE: a future cross-workflow registry
  could live higher up, but with one workflow it stays here — fine.
- `src/oneshot/orchestrator.ts` — update imports: `runBlueprint` from `../blueprints/executor.js`;
  `OneShotContext, OneShotDeps` from `./context.js`; `blueprintFor` from `./registry.js`.
  The `ctx`/`deps` construction and the parse/lease/revoke flow are **unchanged** (just the
  type names: `const ctx: OneShotContext = {...}; const deps: OneShotDeps = {...}`).

### 3. Boundary rule — enforce the decoupling (`.dependency-cruiser.cjs`)
Add a forbidden rule (mirror the existing rule style + remediation message):
```js
{
  name: "blueprints-engine-stays-generic",
  severity: "error",
  comment:
    "src/blueprints/ is the generic workflow engine — it must not import workflow-specific " +
    "code (src/oneshot/) or credential/git seams (src/broker/). Keep it parameterized over " +
    "Ctx/Deps: a workflow defines its own context + deps and consumes the engine, never the " +
    "reverse. Move the workflow-specific piece into src/<workflow>/ instead.",
  from: { path: "^src/blueprints/" },
  to: { path: "^src/(oneshot|broker)/" },
},
```
Verify `npm run boundaries` passes with it (the engine must genuinely not import those).

### 4. Engine developer doc — `src/blueprints/README.md`
A concise guide (this is the durable engine doc; one-shot-specific node docs evolve with
S04b and live elsewhere). Cover:
- **What it is** — a blueprint is a declarative `Blueprint<Ctx, Deps>` (an ordered node
  list); `runBlueprint` runs the nodes and emits the gateway `RunnerEvent` stream.
- **The contract** — `BlueprintNode<Ctx, Deps>` = `{name, kind, run(ctx, deps)}`; nodes
  read/write the shared `ctx`; a node throw becomes a single `error` event and stops the run.
- **deterministic vs agentic** (`NodeKind`) — agentic nodes delegate to a sandbox
  `SessionRunner`; the engine itself never runs agent code (the container is the boundary).
- **How to build a workflow on it** — (1) define your `Ctx` + `Deps`; (2) write nodes
  typed as `BlueprintNode<Ctx, Deps>`; (3) compose a `Blueprint` list; (4) run via
  `runBlueprint`. Point to `src/oneshot/` as the worked example (context.ts, nodes/,
  repo-oneshot.ts, registry.ts, orchestrator.ts).
- **What the engine deliberately does NOT know** — git, credentials/leases, Slack,
  profiles. Those live in the workflow. (Enforced by the `blueprints-engine-stays-generic`
  boundary rule.)
- Keep it tight — the engine is two small files; the README orients, it doesn't sprawl.

## Acceptance criteria

1. `npm run gate` passes — **`test/oneshot.test.ts` green with ZERO edits**, all other
   tests pass, and `npm run boundaries` is clean *with the new rule present*. Paste the tail.
2. `src/blueprints/` contains only the generic engine (`types.ts`, `executor.ts`, `README.md`)
   and imports nothing from `src/oneshot/` or `src/broker/` (the new boundary rule enforces this).
3. `src/oneshot/blueprints/` no longer exists; its pieces live at `src/oneshot/context.ts`,
   `src/oneshot/nodes/*`, `src/oneshot/repo-oneshot.ts`, `src/oneshot/registry.ts`.
4. The engine is generic: `runBlueprint<Ctx, Deps>`, `BlueprintNode<Ctx, Deps>`,
   `Blueprint<Ctx, Deps>`. `repoOneshot` is a `Blueprint<OneShotContext, OneShotDeps>`.
5. **Tests** — update `test/blueprint.test.ts` (or split into engine + oneshot files), and:
   - The **engine** tests prove genericity by running `runBlueprint` over a **minimal local
     stub context/deps** defined in the test (e.g. `interface TestCtx { marker?: string }`,
     `interface TestDeps {}`) — NOT the one-shot types. Keep the existing coverage: nodes
     run in order + events forwarded; a throwing node → exactly one error event, stops, no
     re-throw, later node skipped; context threading (a node writes `ctx.marker`, a later
     node reads it). Engine imports from `src/blueprints/...` only.
   - The **registry/blueprint** tests (`blueprintFor('repo-oneshot')` → node names `['clone',
     'implement','push','open-pr']` in order; unknown id throws; identity is `repoOneshot`;
     only `implementNode` is `agentic`) import from `src/oneshot/registry.js` +
     `src/oneshot/repo-oneshot.js`.
6. `src/blueprints/README.md` exists per section 4.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the real tail. Suite is offline.
- **No `any`, no `@ts-ignore`**; `NodeNext` ESM (`.js` specifiers); `strict` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` on (assign only defined values
  to optional ctx fields — `ctx.prUrl = url`, never `= undefined`).
- **No behavior change.** `test/oneshot.test.ts` is the proof — green, unedited. The
  `OneShotOrchestrator` constructor signature, the `RunnerEvent`/`SessionRunner` contracts,
  the protocol, broker, and `DockerGitNodeExecutor` are all untouched.
- **Boundaries**: the new engine must not import `oneshot/`/`broker/`; no cycles (the
  generic split removes any risk — engine → runner/types only; oneshot → engine). No
  `@slack/bolt`, no `runner/` package, no Agent SDK in `src/blueprints/`.
- Never log message contents or tokens.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build) — these are S04b

- `branch`/research/plan/lint/test nodes, the `boundedRetry` combinator, the classifier.
- The agentic-node **lease-free context view** (splitting OneShotContext so agentic nodes
  can't see the lease). That is an S04b design item — keep `OneShotContext` as-is here.
- A cross-workflow/global blueprint registry — one workflow today; `blueprintFor` stays in
  `src/oneshot/`.

## When done — report precisely (with REAL command output)

- What changed/moved, file by file (one line each); the new `src/blueprints/` files.
- The real tail of `npm run gate` (test count ≥ 185; name the new total).
- Confirm `git status` shows `src/oneshot/blueprints/` deleted and `test/oneshot.test.ts`
  NOT in the diff.
- Confirm `npm run boundaries` passes with the new `blueprints-engine-stays-generic` rule.
- Any deviation from this spec and why.
