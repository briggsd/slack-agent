# Task: extract & export `RequestCoordinator`, migrate the 5 standalone coordinators onto it

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc). **Read the root `CLAUDE.md` and `runner/CLAUDE.md` first** (gate, invariants,
conventions), then the context below. You are on branch
`sonnet/toolshed-s1-request-coordinator`.

This is a **behavior-preserving refactor**. No protocol change, no gateway (`src/`) change,
no new feature. Tracks `track 8ee7d3` (toolshed trim, slice 1). Background: see
`docs/toolshed.md` ("Where this is heading") — the `RequestCoordinator` base already exists
but lives privately in `runner/src/publish.ts` and only the publish family uses it. This
slice extracts it so it is reusable, and collapses the five hand-rolled copies onto it.

## Context — the exact current state

`runner/src/publish.ts` defines a generic base class `RequestCoordinator<TInput,
TResultMessage extends { id: string }, TOutcome>` (currently **not exported**). It owns
`pending` (a Map of id→resolve), a `seq` counter, a `drained` flag, and three methods:
`request(input)`, `handleResult(msg)`, `failAllPending()`. The three publish-family
coordinators (`PublishCoordinator`, `EditPrCoordinator`, `CommentPrCoordinator`) are already
thin wrappers over it — **they are your exact template for the migration.**

Five other coordinators hand-roll the identical shape and must move onto the base:

| File | Class | Outcome type | `request*` method | id prefix |
|---|---|---|---|---|
| `runner/src/clone.ts` | `CloneCoordinator` | `{ok:true; workdir}` / `{ok:false; error}` | `requestClone(repo: string)` | `clone` |
| `runner/src/build.ts` | `BuildCoordinator` | `{ok:true}` / `{ok:false; reason}` | `requestBuild(repo: string)` | `build` |
| `runner/src/exec.ts` | `ExecCoordinator` | `{ok:true; prUrl?}` / `{ok:false; reason}` | `requestExec(input: ExecInput)` | `exec` |
| `runner/src/checks.ts` | `ChecksCoordinator` | `{ok:true; results}` / `{ok:false; reason}` | `requestChecks(input: ChecksInput)` | `checks` |
| `runner/src/provision.ts` | `ProvisionCoordinator` | `{ok:true}` / `{ok:false; error}` | `requestProvision(input: ProvisionInput)` | `provision` |

`ApprovalCoordinator` (`runner/src/approval.ts`) is **NOT** part of this — it does file
persistence + verdict routing, not the simple request/result shape. Do not touch it.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the refactor is done AND `npm run gate` passes.
Make every edit, run the gate, fix failures, then stop. Yielding after only exploring
(zero file changes) is a failure.

## CRITICAL — preserve public API + behavior exactly

The whole point is that **callers and existing tests do not change**. Each coordinator must
keep its exact public surface: the same class name, the same `requestX` / `handleResult` /
`failAllPending` method names and signatures, and the same exported `*Outcome` / `*Input` /
`EmitRequest*Fn` types. `runner/src/main.ts` instantiates these classes (lines ~518–594) and
must compile and behave unchanged. Every existing test in `runner/test/` must pass UNCHANGED
— do not edit the existing coordinator tests to make them pass; if one fails, your refactor
changed behavior and is wrong.

## The change

### 1. Extract the base → `runner/src/request-coordinator.ts` (new file)

Move the `RequestCoordinator<TInput, TResultMessage, TOutcome>` class out of `publish.ts`
verbatim into a new `runner/src/request-coordinator.ts`, and **export** it. Keep its
implementation byte-for-byte (the `pending`/`seq`/`drained` fields, `request`,
`handleResult`, `failAllPending`). Add a short module doc comment in the house style.

Update `runner/src/publish.ts` to `import { RequestCoordinator } from
'./request-coordinator.js';` and delete its now-moved local copy. The publish-family classes
stay exactly as they are otherwise.

### 2. Migrate the 5 coordinators — each becomes a thin wrapper

For each of the five files, replace the hand-rolled internals with a single
`RequestCoordinator` instance, mirroring the `PublishCoordinator` template. Keep the public
API identical. Preserve each one's EXACT outcome mapping, shutdown outcome, and id prefix
(copy them verbatim from the current `handleResult` / `failAllPending` / drained-path):

- **clone** (`runner/src/clone.ts`): prefix `'clone'`; success `{ ok: true, workdir:
  msg.workdir ?? '/workspace' }`, failure `{ ok: false, error: msg.error ?? 'clone failed'
  }`, shutdown `{ ok: false, error: 'shutting down' }`. `requestClone(repo)` → `base.request(repo)`.
- **build** (`runner/src/build.ts`): prefix `'build'`; success `{ ok: true }`, failure
  `{ ok: false, reason: msg.reason ?? 'build failed' }`, shutdown `{ ok: false, reason:
  'shutting down' }`. `requestBuild(repo)` → `base.request(repo)`.
- **exec** (`runner/src/exec.ts`): prefix `'exec'`; success must replicate the conditional
  exactly — `msg.prUrl !== undefined ? { ok: true, prUrl: msg.prUrl } : { ok: true }`
  (do NOT write `{ ok: true, prUrl: msg.prUrl }` unconditionally — `exactOptionalPropertyTypes`
  forbids assigning `undefined` to the optional `prUrl`). Failure `{ ok: false, reason:
  msg.reason ?? 'exec failed' }`, shutdown `{ ok: false, reason: 'shutting down' }`.
  `requestExec(input)` → `base.request(input)`.
- **checks** (`runner/src/checks.ts`): prefix `'checks'`; success `{ ok: true, results:
  msg.results ?? [] }`, failure `{ ok: false, reason: msg.reason ?? 'run checks failed' }`,
  shutdown `{ ok: false, reason: 'shutting down' }`. **Preserve the input normalization**:
  `requestChecks` currently builds `{ repo: input.repo, kind: input.kind ?? 'all' }` BEFORE
  emitting. Keep that — normalize in the wrapper, then call `base.request(normalized)`.
- **provision** (`runner/src/provision.ts`): prefix `'provision'`; success `{ ok: true }`,
  failure `{ ok: false, error: msg.error ?? 'runtime provision failed' }`, shutdown
  `{ ok: false, error: 'shutting down' }`. `requestProvision(input)` → `base.request(input)`.

The wrapper shape to mirror (from `PublishCoordinator`):
```ts
export class CloneCoordinator {
  private readonly base: RequestCoordinator<string, CloneResultMessage, CloneOutcome>;
  constructor(emitRequest: EmitRequestCloneFn) {
    this.base = new RequestCoordinator('clone', emitRequest,
      (msg) => msg.ok ? { ok: true, workdir: msg.workdir ?? '/workspace' }
                      : { ok: false, error: msg.error ?? 'clone failed' },
      { ok: false, error: 'shutting down' });
  }
  requestClone(repo: string): Promise<CloneOutcome> { return this.base.request(repo); }
  handleResult(msg: CloneResultMessage): boolean { return this.base.handleResult(msg); }
  failAllPending(): void { this.base.failAllPending(); }
}
```
Keep each file's existing exported types and its module doc comment (trim the doc only where
it now describes internals that moved to the base).

## Acceptance criteria

1. `npm run gate` passes (`npm run check` + `npm run boundaries`): tsc + runner type-check +
   vitest all green, dependency-cruiser clean. **The existing test count must not drop**, and
   no existing test file under `runner/test/` is edited.
2. `runner/src/request-coordinator.ts` exists and exports `RequestCoordinator`; `publish.ts`
   imports it and no longer declares its own copy.
3. All five coordinators (`clone`, `build`, `exec`, `checks`, `provision`) delegate to a
   `RequestCoordinator` instance and keep their exact public API and outcome behavior.
4. `runner/src/main.ts` is unchanged except (optionally) nothing — it should not need edits.
5. No change under `src/` (gateway), no change to either `protocol.ts` copy.

## Tests

- The five existing coordinator unit tests (`runner/test/{clone,build,exec,checks,provision}.test.ts`)
  and the tool tests (`*-tool.test.ts`) are your regression net — they must pass UNCHANGED.
  Run them; if any fails, you changed behavior — fix the refactor, not the test.
- **ADD** `runner/test/request-coordinator.test.ts`: a focused unit test of the extracted
  base in isolation (mirror the style of `runner/test/publish.test.ts`). Cover: `request`
  emits with the `"<prefix>-<n>"` id and returns a pending promise; `handleResult` resolves
  the matching id via `fromMessage` and returns `true`; an unknown id returns `false`;
  after `failAllPending`, pending promises resolve to the shutdown outcome AND a subsequent
  `request` resolves immediately to the shutdown outcome (the `drained` path). Use a trivial
  `TInput`/`TResultMessage`/`TOutcome` so the test needs no real protocol types.

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** (pass/fail counts) + `git diff --stat`.
- No `any`, no `@ts-ignore`. `NodeNext` ESM (`.js` import specifiers). Honor
  `exactOptionalPropertyTypes` (see the exec note).
- Do NOT touch `protocol.ts` (either copy), `approval.ts`, or anything under `src/`.
- Do NOT edit existing tests to force a pass.
- Do NOT commit — leave the working tree for review. Do NOT `git add -A`. (The spec file is
  already committed as the branch's first commit.)

## Out of scope (do NOT build)

- The docker.ts service-dispatch helper (that's slice 2) and `read_issue` (slice 3).
- Migrating `ApprovalCoordinator`.
- Any protocol or gateway change.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- The real tail of `npm run gate` (pass/fail counts) + `git diff --stat`.
- Confirm no existing `runner/test/` file was modified and the test count rose by exactly the
  new base test (state old/new counts).
- Any deviation from this spec and why.
