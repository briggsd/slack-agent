# Task: M5 S04a — declarative blueprint framework + port today's one-shot flow onto it (no behavior change)

You are implementing one slice in this checkout (a git worktree of `slack-agent`:
TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(the gate, invariants, conventions), then this spec. You are on branch
`sonnet/m5-s04a-blueprints`. **Do NOT edit this spec file.**

## What this slice delivers

Today the one-shot blueprint is a hardcoded imperative async generator inside
`OneShotOrchestrator.send()`. S04 will grow it (research/plan/branch/lint/test/retry),
so we first restructure it into a **declarative list of nodes** that is easy to read,
extend, and reuse — *without changing behavior*. This slice is a pure refactor behind
the `OneShotOrchestrator` seam:

- A `blueprints/` framework: a `BlueprintNode`, a `Blueprint` (an ordered node list), a
  threaded `BlueprintContext`, injected `NodeDeps`, and a `blueprintFor()` registry.
- An `executor.ts` that runs a blueprint and owns the lease lifecycle + error handling.
- Today's exact four steps ported to nodes: **clone → implement → push → open PR**.
- `OneShotOrchestrator` slimmed to: parse → build context → look up blueprint → run it.

**The proof of "no behavior change": `test/oneshot.test.ts` must stay green with ZERO
edits.** It drives `OneShotOrchestrator.send()` and pins every behavior (event order,
lease-once/revoke-once, error mapping, terminal PR text, workdir derivation, dispose).
If you feel tempted to edit it, your refactor changed behavior — fix the code instead.

> **Out of scope for S04a** (these are S04b — do NOT build them now): the `branch`
> node, research/plan/lint/test nodes, the `boundedRetry` combinator, the failure
> classifier, and the agent-workdir/commit fix for the live-smoke 422. S04a ports the
> *current* flow verbatim, including its known incompleteness (no branch node).

## Context — read before writing code (grounded)

The current implementation you are refactoring — read it carefully, it is your
behavioral spec:

- `src/oneshot/orchestrator.ts` — `OneShotOrchestrator implements SessionRunner`. Its
  `send(message)` async generator does, in order:
  1. `parseOneShotTask(message)`; on null → yield `{type:'error', message:'Invalid task
     format. Expected: <host>:<owner>/<repo> <instruction>'}` and return (NO lease).
  2. Compute `branch = \`slackbot/oneshot-${taskId}\`` and
     `workdir = \`/workspace/${repo.replaceAll('/','-')}\``.
  3. `lease = await broker.lease({host, repo, taskId})` inside try/catch — on reject,
     yield `{type:'error', message: err.message}` and return (NO revoke — no lease).
  4. `revokeOnce()` guard (revoke at most once, swallow revoke errors).
  5. status `'cloning repository…'` → `gitNodes.clone({lease, repo, workdir, volume})`.
  6. status `'implementing…'` → iterate `inner.send(instruction)`: forward inner
     `status` events; capture the last `text` into `implementResult`; on inner `error`
     set `innerError` and break; ignore inner `file` events. After the loop, if
     `innerError !== null` throw `new Error(\`Inner agent error: ${innerError}\`)`.
  7. status `'pushing branch…'` → `gitNodes.push({lease, repo, branch, workdir, volume})`.
  8. status `'opening pull request…'` → build `title = instruction.split('\n')[0]?.slice(0,72) ?? instruction.slice(0,72)`;
     `body = implementResult !== '' ? implementResult.slice(0,500) : \`Automated one-shot implementation.\n\nTask: ${title}\``;
     `{url} = await gitNodes.openChangeRequest({lease, repo, head: branch, base:'main', title, body})`.
  9. `revokeOnce()` then yield `{type:'text', text:\`Opened PR: ${url}\`}`.
  10. A surrounding try/catch: any throw → `revokeOnce()` + yield `{type:'error', message}`.
      A `finally` calls `revokeOnce()` (idempotent).
  - `volume = volumeNameFor(sessionKey)` (computed in the ctor).
  - `taskId = taskId ?? \`${Date.now()}-${Math.random().toString(36).slice(2,9)}\``.
  - `dispose()` → `await inner.dispose()`.
- `src/runner/types.ts` — `RunnerEvent` = `{type:'status';text}` | `{type:'file';name;data:Buffer}` |
  `{type:'text';text}` | `{type:'error';message}`. `SessionRunner` = `{ send(message): AsyncIterable<RunnerEvent>; dispose(): Promise<void> }`.
- `src/oneshot/git-node.ts` — `GitNodeExecutor` = `clone(CloneRequest)`, `push(PushRequest)`,
  `openChangeRequest(OpenChangeRequest): Promise<{url:string}>`. Request shapes:
  `CloneRequest{lease,repo,workdir,volume}`, `PushRequest{lease,repo,branch,workdir,volume}`,
  `OpenChangeRequest{lease,repo,head,base,title,body}`.
- `src/broker/types.ts` — `CredentialBroker.lease(req)`, `CredentialLease{token,host,repo,revoke()}`,
  `GitHost='github'|'gitlab'`.
- `src/oneshot/parse.ts` — `parseOneShotTask(message): {host,repo,instruction} | null`.
- `src/runner/docker.ts` — `volumeNameFor(sessionKey): string`.
- `src/profiles/registry.ts` — `REPO_ONESHOT_PROFILE_ID = 'repo-oneshot'`.
- `src/oneshot/dispatching-factory.ts` — constructs `new OneShotOrchestrator(inner, broker,
  gitNodes, sessionKey)`. **Keep the OneShotOrchestrator constructor signature unchanged**
  (`(inner, broker, gitNodes, sessionKey, taskId?)`) so this file needs no edit.

Test infra (read for patterns/fakes): `test/oneshot.test.ts` (the behavior pin — must stay
green unchanged), `src/runner/fake.ts` (`FakeRunner(sessionId, scriptedTurns?)`, records
`sends`, `disposed`), `src/broker/fake.ts` (`FakeBroker`, records `leases`/`revokes`),
`src/oneshot/fake-git-node.ts` (`FakeGitNodeExecutor(prUrl?)`, records `clones`/`pushes`/
`changeRequests`, has `failNextPush`/`failNextOpenChange`).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this run.

## Implementation

### 1. `src/oneshot/blueprints/types.ts`
```ts
import type { RunnerEvent, SessionRunner } from '../../runner/types.js';
import type { CredentialLease, GitHost } from '../../broker/types.js';
import type { GitNodeExecutor } from '../git-node.js';

export type NodeKind = 'deterministic' | 'agentic';

/** Dependencies a node may use. Only 'agentic' nodes may touch `inner`. */
export interface NodeDeps {
  readonly inner: SessionRunner;       // the sandbox runner (agentic nodes only)
  readonly gitNodes: GitNodeExecutor;  // deterministic credentialed git ops
}

/** Shared state threaded through a blueprint's nodes. Inputs are readonly;
 *  accumulators are filled by nodes as the blueprint runs. */
export interface BlueprintContext {
  readonly host: GitHost;
  readonly repo: string;
  readonly instruction: string;
  readonly taskId: string;
  readonly volume: string;
  readonly workdir: string;
  readonly branch: string;
  readonly lease: CredentialLease;
  // accumulators
  implementSummary?: string;
  prUrl?: string;
}

export interface BlueprintNode {
  readonly name: string;
  readonly kind: NodeKind;
  /** Yields events; reads and writes ctx. Throwing aborts the blueprint (the
   *  executor turns it into a single error event + teardown). */
  run(ctx: BlueprintContext, deps: NodeDeps): AsyncIterable<RunnerEvent>;
}

export interface Blueprint {
  readonly id: string;
  readonly nodes: readonly BlueprintNode[];
}
```
Keep the doc comments — they are the living documentation of the model. Use `.js`
import specifiers (NodeNext). No `any`.

### 2. `src/oneshot/blueprints/nodes/` — one file per node
Each exports a `const <name>Node: BlueprintNode`. Port the exact behavior from the
orchestrator step list above. Use async-generator `run`s.
- `clone.ts` → `cloneNode` (deterministic): yield status `'cloning repository…'`; `await
  deps.gitNodes.clone({lease: ctx.lease, repo: ctx.repo, workdir: ctx.workdir, volume: ctx.volume})`.
- `implement.ts` → `implementNode` (agentic): yield status `'implementing…'`; iterate
  `deps.inner.send(ctx.instruction)` exactly as step 6 (forward inner `status`; capture last
  `text` into `ctx.implementSummary`; on inner `error`, throw `new Error(\`Inner agent error:
  ${message}\`)`; ignore `file`). This is the ONLY node that touches `deps.inner`.
- `push.ts` → `pushNode` (deterministic): yield status `'pushing branch…'`; `await
  deps.gitNodes.push({lease: ctx.lease, repo: ctx.repo, branch: ctx.branch, workdir: ctx.workdir, volume: ctx.volume})`.
- `open-pr.ts` → `openPrNode` (deterministic): yield status `'opening pull request…'`; build
  `title`/`body` exactly as step 8 (from `ctx.instruction` and `ctx.implementSummary ?? ''`);
  `const {url} = await deps.gitNodes.openChangeRequest({lease: ctx.lease, repo: ctx.repo,
  head: ctx.branch, base:'main', title, body})`; set `ctx.prUrl = url`; yield `{type:'text',
  text:\`Opened PR: ${url}\`}`.

### 3. `src/oneshot/blueprints/repo-oneshot.ts`
```ts
export const repoOneshot: Blueprint = {
  id: 'repo-oneshot',
  nodes: [cloneNode, implementNode, pushNode, openPrNode],
};
```

### 4. `src/oneshot/blueprints/registry.ts`
`export function blueprintFor(blueprintId: string): Blueprint` — returns `repoOneshot`
for `'repo-oneshot'`; throws `new Error(\`no blueprint for id "${blueprintId}"\`)` for an
unknown id. (One entry now; this is the extensibility seam.)

### 5. `src/oneshot/executor.ts`
`export async function* runBlueprint(blueprint: Blueprint, ctx: BlueprintContext, deps:
NodeDeps): AsyncGenerator<RunnerEvent>`. It runs the nodes in order, forwarding each
node's events; on any node throw, yield `{type:'error', message}` and stop. It does NOT
own the lease here (the lease is in ctx and revocation stays in the orchestrator's
finally, see step 6) — keep the executor focused on sequencing + error mapping so the
revoke-once guard remains in one place. (A node throwing must still leave the orchestrator's
`finally` to revoke.)

> Rationale for keeping revoke in the orchestrator, not the executor: the lease must be
> revoked exactly once whether the failure is parse (pre-lease), lease-acquire, or a node
> throw — the orchestrator already wraps all of those. Threading revoke into the executor
> would split the guard. Keep `runBlueprint` a pure sequencer.

### 6. `src/oneshot/orchestrator.ts` — slim it down
`send(message)` becomes:
1. `parseOneShotTask` → on null, yield the same `'Invalid task format…'` error and return.
2. Compute `branch`, `workdir` (same formulas).
3. try `lease = await broker.lease(...)` / catch → yield error + return.
4. `revokeOnce` guard (unchanged).
5. Build `ctx: BlueprintContext` and `deps: NodeDeps = {inner, gitNodes}`.
6. `try { for await (const ev of runBlueprint(blueprintFor(REPO_ONESHOT_PROFILE_ID), ctx,
   deps)) yield ev; await revokeOnce(); } catch { await revokeOnce(); yield error } finally
   { await revokeOnce(); }`.
   - Note: `runBlueprint` already converts a node throw into an `error` event (it won't
     re-throw), so the terminal-text-vs-error and revoke-once semantics match today. Make
     sure exactly one revoke happens and the existing tests' event expectations hold —
     verify against `test/oneshot.test.ts` (do not edit it).
   `dispose()` unchanged (`await inner.dispose()`, idempotent).

Keep the constructor signature and `volumeNameFor`/`taskId` defaulting exactly as today.

## Acceptance criteria

1. `npm run gate` passes — **`test/oneshot.test.ts` is green with ZERO edits** (the
   no-behavior-change proof), all other existing tests still pass, `npm run boundaries`
   stays clean. Paste the tail.
2. The blueprint reads as a declarative list in `repo-oneshot.ts`: `[cloneNode,
   implementNode, pushNode, openPrNode]`.
3. `OneShotOrchestrator.send()` no longer contains the inline clone/implement/push/PR
   logic — it delegates to `runBlueprint` over `blueprintFor(...)`.
4. **New tests** (e.g. `test/blueprint.test.ts`) covering the framework independently of
   the specific nodes:
   - `runBlueprint` runs nodes in order and forwards their events (use 2–3 tiny stub
     `BlueprintNode`s that yield a marker status each + mutate ctx; assert order).
   - A stub node that throws → `runBlueprint` yields exactly one `error` event, stops
     (later nodes do not run), and does not re-throw.
   - A stub node writes `ctx.prUrl`/`ctx.implementSummary` and a later node reads it
     (proves context threading).
   - `blueprintFor('repo-oneshot')` returns a blueprint whose node names are, in order,
     the four expected names; `blueprintFor('nope')` throws.
   - (Optional) assert each `repoOneshot` node's `kind`, and that only `implementNode` is
     `'agentic'`.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the real tail. Suite is offline — no Slack,
  Docker, API, or network. New tests use the existing fakes / tiny stub nodes only.
- **No `any`, no `@ts-ignore`**; `NodeNext` ESM (`.js` specifiers); `strict` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on. Optional ctx
  accumulators: assign a defined value (`ctx.prUrl = url`) — never assign `undefined`.
- **Boundaries** (enforced): everything new lives under `src/oneshot/`; import only from
  `runner/types` (types), `broker/types`, `git-node`, `parse`, `docker` (volumeNameFor),
  `profiles/registry`. No `@slack/bolt`, no `runner/` package, no Agent SDK, no cycles.
- **The gateway never runs agent code**: only `agentic` nodes (`implementNode`) may touch
  `deps.inner`. Deterministic nodes never call it.
- Never log message contents or tokens.
- Do NOT change behavior, the `RunnerEvent`/`SessionRunner` contracts, the protocol, the
  broker, `DockerGitNodeExecutor`, or the `OneShotOrchestrator` constructor signature.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build) — these are S04b

- `branchNode`, `researchNode`, `planNode`, `lintNode`, `testNode`.
- `boundedRetry` combinator + `classify.ts` failure classifier.
- The agent-workdir/commit fix for the live-smoke 422 (the implement node tells the agent
  the clone workdir). S04a ports the current implement step verbatim.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each); list the new `blueprints/` files.
- The real tail of `npm run gate` (test count must be ≥ current 178; name the new total).
- Confirm `test/oneshot.test.ts` was NOT edited (`git diff --stat` should not list it).
- Any deviation from this spec and why.
