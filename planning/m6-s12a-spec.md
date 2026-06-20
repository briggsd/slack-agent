# S12a — the build engine: a coordinator-driven build tail (offline half)

One slice in this repo (TS, Node 20+, ESM, vitest, strict). Read root `CLAUDE.md` (the gate,
invariants) before starting. This is the **offline half** of S12 — everything here is testable
with the existing fakes; **no Docker / Slack / network**.

## Anti-yield directive (read first)

Implement this **end to end** + tests, run `npm run gate` in this worktree, fix failures, then
stop. Yielding after only exploring (zero file changes) is a failure. Do **not** edit this spec.
Paste the real `npm run gate` tail (with pass/fail counts) in your report — an empty/countless
tail reads as "I truncated before verifying."

## What this slice does (and the design rule that bounds it)

The coordinator (a router container, built in S10/S11) is the intelligent main loop. In S12 it
will **drive the build as one blocking tool**: gate the spec with a human, then run a fresh
implementer container to a PR, and read the result. **This slice (S12a) builds the gateway-side
build engine and the manager path that runs it** — the protocol round-trip + container tool
(`request_build`/`build_result`, `docker.ts` relay, the renamed `build_spec` tool, system
prompt) is the *other* half, S12b. Do **not** build S12b here.

**Design rule (hold it — it is the antidote to over-building):** a SMALL set of hard guardrails
(human gate, sandbox, gateway-held credentials, PR-only, input validation) and inside them a
flexible path. Failures come back as **data** (a `BuildOutcome`), never brittle gateway
auto-recovery. Keep the diff focused; resist adding fields/branches not specified here.

## Background you can rely on (verified against current `main`, HEAD `b06f11e`)

- A session already has a **shared Docker volume** `slackbot-ws-<sanitized-key>`
  (`volumeNameFor(sessionKey)`, `src/runner/docker.ts`). S11's `clone_repo` clones the repo into
  it at workdir **`/workspace/${repo.replaceAll('/', '-')}`** (`src/oneshot/clone-service.ts:37`).
  The build tail mounts the **same volume** and operates on that same checkout — so the tail's
  workdir must be derived identically (it already is: `OneShotOrchestrator` computes
  `/workspace/${repoSlug}`, `orchestrator.ts:62-63`).
- The blueprint engine (`runBlueprint`, `src/blueprints/executor.ts:4-21`) runs an ordered list
  of nodes over a context; a node failure is converted to a yielded `error` event and the run
  returns normally (it does **not** throw). Nodes for git ops already exist and are reused
  verbatim — see below.

## Build — 6 pieces

### 1. Types — `src/runner/types.ts`

- Add to the `RunnerEvent` union (alongside `pr_opened`, which is the precedent — a
  gateway-internal event, never crosses the wire):
  ```ts
  // gateway-internal: the coordinator's build_spec tool asked the gateway to run the build
  // tail (a fresh implementer container on the shared volume). The manager services it and
  // feeds a BuildOutcome back via next(); it never crosses the container boundary as-is.
  | { type: 'run_build'; repo: string; volume: string }
  ```
- Add the outcome type (the data the coordinator reasons over — keep it to these two shapes;
  a richer payload is a later enhancement, explicitly out of scope):
  ```ts
  export type BuildOutcome =
    | { ok: true; prUrl: string }
    | { ok: false; reason: string };  // short, token-free
  ```
- Widen `RunnerStream`'s `TNext` so a `BuildOutcome` can thread back the same way a
  `GateResume` does today:
  ```ts
  export type RunnerStream = AsyncGenerator<RunnerEvent, void, GateResume | BuildOutcome | undefined>;
  ```
- Widen `RunnerFactory.create` with an **optional** opts arg so a distinctly-named container can
  be requested (the build tail can't share the router's `--name`):
  ```ts
  create(sessionKey: string, profile: Profile, opts?: { nameSuffix?: string }): Promise<SessionRunner>;
  ```
- Add the new factory capability the manager depends on (a separate interface so the manager's
  type stays honest — it gets a `BuildRunnerFactory`, not the broker/gitNodes):
  ```ts
  /** Builds the one-shot "build tail": a fresh implementer container on the session's shared
   *  volume, wrapped in the build-tail blueprint. Implemented by DispatchingRunnerFactory
   *  (it holds the broker + git nodes); injected into the SessionManager. */
  export interface BuildRunnerFactory {
    createBuildRunner(sessionKey: string, repo: string): Promise<SessionRunner>;
  }
  ```

### 2. `build-tail` blueprint — new `src/oneshot/build-tail.ts`

The build tail skips clone/research/plan/plan-gate (the tree is already on the volume from S11;
the conversation replaced planning). It is just branch → implement/lint/test (with retry) → push
→ open-pr. **Reuse the existing nodes and the shared `fixLoop`** (do not reconstruct the retry
loop — `fixLoop` already carries the right `decide`, `src/oneshot/repo-oneshot.ts:40-43`):

```ts
import type { OneShotBlueprint } from './context.js';
import { branchNode } from './nodes/branch.js';
import { pushNode } from './nodes/push.js';
import { openPrNode } from './nodes/open-pr.js';
import { fixLoop } from './repo-oneshot.js';

export const buildTail: OneShotBlueprint = {
  id: 'build-tail',
  nodes: [branchNode, fixLoop, pushNode, openPrNode],
};
```

Register it in `src/oneshot/registry.ts` by adding `buildTail` to the `BLUEPRINTS` array (and the
import). It is a **blueprint id only — NOT a Profile** (it is invoked directly via
`createBuildRunner`, never through profile-mode dispatch), so do **not** add a `profiles/registry.ts`
entry.

### 3. Explicit-context path on `OneShotOrchestrator` — `src/oneshot/orchestrator.ts`

Today `send()` parses the task out of the message (`parseOneShotTask`, `orchestrator.ts:47`). The
build tail has no task message — the host/repo/instruction are known at construction. Add an
**optional** constructor param and branch `send()` on it; **everything after the host/repo/
instruction is resolved stays identical** (branch name, workdir, lease mint, `revokeOnce`, ctx/deps
build, `runBlueprint`, the `finally`).

- Constructor: add a 7th optional param after `blueprintId`:
  ```ts
  explicitTask?: { host: GitHost; repo: string; instruction: string }
  ```
  Store it (`import type { GitHost } from '../broker/types.js'`). `exactOptionalPropertyTypes` is
  on — store as `private readonly explicitTask: {...} | undefined`.
- In `send()`, replace the parse block (`orchestrator.ts:47-56`) with:
  ```ts
  let host: GitHost, repo: string, instruction: string;
  if (this.explicitTask !== undefined) {
    ({ host, repo, instruction } = this.explicitTask);
  } else {
    const parsed = parseOneShotTask(message);
    if (parsed === null) {
      yield { type: 'error', message: 'Invalid task format. Expected: <host>:<owner>/<repo> <instruction>' } satisfies RunnerEvent;
      return;
    }
    ({ host, repo, instruction } = parsed);
  }
  ```
  Leave the rest of `send()` untouched. (When `explicitTask` is set the `message` arg is unused —
  that's intended; the build tail's runner is driven with a placeholder message.)

### 4. `createBuildRunner` on `DispatchingRunnerFactory` — `src/oneshot/dispatching-factory.ts`

It already holds `agentFactory` + `broker` + `gitNodes`. Implement `BuildRunnerFactory`
(`implements RunnerFactory, BuildRunnerFactory`) and add:

```ts
async createBuildRunner(sessionKey: string, repo: string): Promise<SessionRunner> {
  // Fresh inner container on the SHARED volume, distinct name so it can co-exist with the router.
  const inner = await this.agentFactory.create(sessionKey, getProfile('conversational'), { nameSuffix: 'build' });
  const instruction =
    'Implement the approved spec.\n\n' +
    'The approved spec is at /workspace/SPEC.md. Read it and implement it in the repository ' +
    'working tree, committing your changes before you finish. Note any deviations in your final summary.';
  return new OneShotOrchestrator(
    inner, this.broker, this.gitNodes, sessionKey,
    undefined, 'build-tail', { host: 'github', repo, instruction },
  );
}
```

(The instruction's **first line becomes the PR title** via `openPrNode` — `open-pr.ts:50` — so keep
it a clean one-liner. The workdir + branch are told to the agent by the shared `implementNode`
directive, so the instruction need not repeat them. The implement directive still says "Implement
the plan you produced" — harmless here since the appended instruction is authoritative; rewording
the shared node is **out of scope**.)

### 5. `nameSuffix` in `DockerRunnerFactory.create` — `src/runner/docker.ts:639-670`

Honour the new optional opts arg; distinct **name**, **same** volume:

```ts
async create(sessionKey: string, _profile: Profile, opts?: { nameSuffix?: string }): Promise<SessionRunner> {
  const safe = sanitizeKey(sessionKey);
  const suffix = opts?.nameSuffix !== undefined ? `-${opts.nameSuffix}` : '';
  const containerName = `slackbot-${safe}${suffix}`;
  const volumeName = volumeNameFor(sessionKey);   // UNCHANGED — shared volume
  // …rest unchanged…
}
```

`FakeRunnerFactory.create` (`src/runner/fake.ts`) must accept the same optional opts arg.
**Record it** so tests can assert the tail was requested with `nameSuffix:'build'` — e.g. push to a
`public readonly suffixes: (string | undefined)[]` alongside the existing `profiles` array.

### 6. Manager — `driveToThread` extraction + `runBuild` — `src/sessions/manager.ts`

**6a. Extract the per-event drive block.** Lines **548-656** (the `while (true) { … }` event loop
*and* its surrounding `try { … } finally { iterator.return() }`) move verbatim into a new private
method, called by the existing drain path. Signature:

```ts
private async driveToThread(
  iterator: RunnerStream,
  placeholder: Placeholder | null,
  session: Session,
  item: QueueItem,
): Promise<DriveOutcome>
```

The drain path (currently building the iterator at `manager.ts:545` and entering the loop) becomes:
`const iterator = session.runner.send(item.message); await this.driveToThread(iterator, placeholder, session, item);` — i.e. the router turn ignores the return value. **This must be behaviour-preserving
for the router path** (existing router-turn tests stay green).

Inside the extracted loop, capture a terminal outcome and return it (define a private type in the
manager file):
```ts
type DriveOutcome =
  | { type: 'pr_opened'; url: string }
  | { type: 'abandoned'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'completed' };
```
- On `pr_opened`: keep the existing Slack post + audit, **and** set the captured outcome to
  `{ type: 'pr_opened', url: event.url }` (don't break — let the loop drain to `done`).
- On `abandoned`: keep the existing post + audit + `break`; set `{ type: 'abandoned', reason: event.reason }`.
- On `error`: keep the existing post; set `{ type: 'error', message: event.message }`.
- Default when the loop ends with no terminal event captured: `{ type: 'completed' }`.
- Widen the loop's `resume` local from `GateResume | undefined` to
  `GateResume | BuildOutcome | undefined`.

**Add a `run_build` branch** to the loop (symmetric to the `await_approval` branch at
`manager.ts:577-580` — it parks, calls a manager method, and feeds the result back as the next
`resume`):
```ts
} else if (event.type === 'run_build') {
  resume = await this.runBuild(session, item, event);
}
```
(The router turn is the only producer of `run_build`; the build tail's blueprint never yields it,
so no recursion. In S12a the producer is a scripted `FakeRunner` — S12b wires `docker.ts` to emit
it for real and to read the `BuildOutcome` resume back.)

**6b. `runBuild`** — mirrors `awaitApproval`'s shape (`manager.ts:686-743`), but instead of parking
it drives a fresh tail runner to its own placeholder and returns the outcome as data:

```ts
private async runBuild(
  session: Session,
  item: QueueItem,
  event: { repo: string; volume: string },
): Promise<BuildOutcome> {
  const placeholder = await postPlaceholder(this.slack, item.channel, item.threadTs);
  const runner = await this.buildRunnerFactory.createBuildRunner(session.key, event.repo);
  try {
    const outcome = await this.driveToThread(runner.send(''), placeholder, session, item);
    if (outcome.type === 'pr_opened') return { ok: true, prUrl: outcome.url };
    if (outcome.type === 'error') return { ok: false, reason: outcome.message };
    if (outcome.type === 'abandoned') return { ok: false, reason: outcome.reason };
    return { ok: false, reason: 'build finished without opening a PR' };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await runner.dispose();   // ALWAYS dispose the tail container, both paths
  }
}
```

Notes:
- The session stays `draining` throughout (the router turn that yielded `run_build` is still in
  flight) — the idle reaper already backs off while draining. No session-state changes needed.
- The tail's `usage` events are audited automatically because `driveToThread` already contains the
  usage-audit branch. **Do not** add cap enforcement here — `checkCaps` already gates the turn;
  pre-dispatch affordability is S15 (out of scope).
- `buildRunnerFactory` is a new injected dependency — see wiring.

**6c. Inject `buildRunnerFactory`.** Add `private readonly buildRunnerFactory: BuildRunnerFactory`
to `SessionManager`; add `buildRunnerFactory?: BuildRunnerFactory` to the constructor opts and
assign it (it is required for `runBuild`, but make it optional-with-throw or required — see below).
Thread it through `buildGateway` (`src/app.ts:18-43`: add to `GatewayDeps`, pass into
`SessionManager` with the same `...(deps.x !== undefined && {x})` spread style) and pass it from
`src/index.ts:138-151` as `buildRunnerFactory: factory` (the `DispatchingRunnerFactory` now
implements `BuildRunnerFactory`). Because `run_build` only ever fires for one-shot/router sessions
that the `DispatchingRunnerFactory` produces, treat a missing `buildRunnerFactory` as a
programming error: store it as `BuildRunnerFactory | undefined` and have `runBuild` throw a clear
error if it's undefined (don't silently no-op). The fake backend path (`index.ts:127-133`) uses
`FakeRunnerFactory` as the base but still wraps it in `DispatchingRunnerFactory` at `index.ts:136`,
so `factory` always implements `BuildRunnerFactory` — wire it in both backends.

## Invariants (boundary-enforced — `npm run boundaries` fails if broken)

- The gateway never imports the Agent SDK or the `runner/` package; `@slack/bolt` only in
  `src/index.ts`. New gateway-internal types live in `src/runner/` (interface) with impl in
  `src/oneshot/` — the S11 `CloneService` precedent. `DockerRunner` must **not** spawn the tail or
  hold the broker; the **manager/factory** does.
- No `any`, no `@ts-ignore`. NodeNext ESM (`.js` import specifiers). `exactOptionalPropertyTypes`
  is on — set optional fields only when present.
- Never log message content or tokens. (`runBuild` posts placeholders + audits metadata only —
  PR url and cost, never transcript.)
- **No protocol change in this slice.** `run_build`/`BuildOutcome` are gateway-internal
  (`src/runner/types.ts`), not `protocol.ts`. Leave both `protocol.ts` copies untouched — the
  `diff` must stay clean. (The wire messages `request_build`/`build_result` are S12b.)

## Tests (offline, via the existing fakes — this is where the slice is verified)

Fakes to use (all exist): `FakeRunner` + `FakeRunnerFactory` (`src/runner/fake.ts`, scriptable
events + records creates/profiles — extend with the `suffixes` recorder), `FakeBroker`
(`src/broker/fake.ts`, records `leases`/`revokes`), `FakeGitNodeExecutor`
(`src/oneshot/fake-git-node.ts`, records `branches`/`pushes`/`changeRequests`/`checks` and has
`setCheckResult`/`failNext*`), `FakeSlackClient`, `FakeChildProcess`.

1. **Engine via `createBuildRunner`** (`DispatchingRunnerFactory` + `FakeRunnerFactory` base +
   `FakeBroker` + `FakeGitNodeExecutor`): driving the returned runner runs the `build-tail`
   blueprint to a `pr_opened` event; the `FakeGitNodeExecutor` recorded a `branch`, a `push`, and
   one `openChangeRequest` (and **no** clone) on workdir `/workspace/<repo-slug>` + the shared
   volume; the `FakeBroker` minted a lease for `{host:'github', repo}` and it was revoked. Assert
   the inner runner was requested with `nameSuffix:'build'` (via `FakeRunnerFactory.suffixes`).
2. **Distinct container name** (offline, real `DockerRunnerFactory` + `FakeChildProcess` spawn —
   mirror the existing docker-factory create test): `create(key, profile, {nameSuffix:'build'})`
   spawns `docker run … --name slackbot-<safe>-build … -v slackbot-ws-<safe>:/workspace …`;
   `create(key, profile)` (no opts) still yields `slackbot-<safe>` + the same volume.
3. **Manager `runBuild`** via the public drive path (a `FakeRunner` router scripted to yield a
   `run_build` event; inject a fake `BuildRunnerFactory` whose `createBuildRunner` returns a
   scripted tail `FakeRunner`):
   - tail yields `pr_opened` → the build placeholder shows `Opened PR: <url>`, an `open-pr` audit
     is recorded, and the tail runner is disposed;
   - tail yields `error` → tail disposed, no PR audit (the outcome maps to `{ok:false,reason}` —
     assert via the placeholder error text and that dispose ran);
   - the injected `BuildRunnerFactory.createBuildRunner` was called with the event's `repo`.
   (You can assert the returned `BuildOutcome` directly if you drive `runBuild` through the public
   path and capture the resume the router `FakeRunner` receives — but asserting dispose + the
   Slack/audit side-effects is sufficient and simpler.)
4. **`driveToThread` is behaviour-preserving** — the existing router-turn / conversational tests
   that exercise the old inline loop still pass unchanged (extraction only).

## Acceptance

1. `npm run gate` passes — paste the real tail (counts + boundaries). `diff src/runner/protocol.ts
   runner/src/protocol.ts` prints nothing (no protocol change).
2. The four test groups above are present and green; the total test count rose vs the `main`
   baseline.
3. No `submit_spec`/`build_spec` rename, no `request_build`/`build_result` wire messages, no
   `docker.ts` relay, no system-prompt edit (all S12b). No `plan`/`plan-gate`/`clone`/`research`
   node in `build-tail`.

## Out of scope (do not build)

S12b (the wire round-trip: `request_build`/`build_result` in both `protocol.ts` copies, the
`docker.ts` relay yielding `run_build` + reading the `BuildOutcome` resume, the `BuildCoordinator`
in `runner/`, the `submit_spec`→`build_spec` rename, the system prompt). Review node (#36).
`exec` gate-skip (S14). Pre-dispatch spend (S15). A richer `build_result`/summary. Streaming build
steps into the coordinator's context.

## Report

File-by-file changes; the real `npm run gate` tail (counts + boundaries clean); `protocol.ts`
`diff` clean; any deviation from this spec and why; and what only the S12b Docker+credential smoke
can exercise (the real router→gate→build→PR round-trip).
