# Task: M6 S02 — supervised one-shot profile + `task`/`exec` trigger flip + gate-timeout wiring

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is the
worktree checkout — branch `sonnet/m6-s02-supervised-profile`). TypeScript, Node 20+, ESM,
vitest, strict tsc. **Read the root `CLAUDE.md` first** (gate, invariants, conventions),
then the context below.

This slice is pure plumbing for the M6 plan-approval gate. It does NOT add a gate node and
does NOT make any run actually park. It establishes profile selection + trigger parsing so the
S03 gate node has a profile to attach to. The whole point is to prove **selection +
`profile_id` persistence**, with zero behaviour change for existing flows.

## Context — read before writing code

Background (the *why*, summarized — the design notes are gitignored and absent here):
- M6 introduces a **supervised one-shot** mode: a repo task that pauses after planning for
  human approval before implementing. The approval gate node itself lands in **S03**; the
  suspend/await plumbing already landed in **S01** (`SessionManager.awaitApproval`,
  `await_approval` RunnerEvent, two-way `RunnerStream`). This slice (**S02**) only adds the
  *profile* and *trigger* that will select the gated blueprint, plus wires the gate timeout
  from config.
- **Decided design calls** (do not redesign):
  - There is a distinct **`supervised-repo-oneshot` profile** — a new profile, NOT a flag on
    the existing one.
  - A **`planGate` facet** is added to the `Profile` interface (boolean).
  - **Trigger flip:** `task` = **supervised** (gated), `exec` = **fire-and-forget**
    (unsupervised, today's `repo-oneshot` behaviour). This is a pre-release change — no
    migration, no back-compat needed. Today `task` maps to `repo-oneshot`; after this slice
    `task` maps to `supervised-repo-oneshot` and `exec` maps to `repo-oneshot`.

Code this builds on (exact current state):
- `src/profiles/registry.ts` — `Profile { id; label; mode: 'conversational' | 'one-shot' }`;
  `PROFILES` map with `conversational` + `repo-oneshot`; exports `DEFAULT_PROFILE_ID`,
  `REPO_ONESHOT_PROFILE_ID`, `getProfile()` (falls back to default on unknown id, never throws).
- `src/slack/listener.ts` — `parseOneShotTrigger(stripped): string | null` matches
  `/^task\s+(.+)$/is` and returns the remainder (or null). `handleMention` (line ~84) does:
  `const oneShot = parseOneShotTrigger(stripped); const profileId = oneShot !== null ?
  REPO_ONESHOT_PROFILE_ID : DEFAULT_PROFILE_ID; const message = oneShot ?? stripped;`
- `src/oneshot/registry.ts` — `BLUEPRINTS = [repoOneshot]`; `blueprintFor(blueprintId)` finds by
  `b.id`, throws on unknown.
- `src/oneshot/repo-oneshot.ts` — exports `repoOneshot: OneShotBlueprint` with
  `id: 'repo-oneshot'` and `nodes: [cloneNode, researchNode, planNode, branchNode, fixLoop,
  pushNode, openPrNode]`.
- `src/oneshot/orchestrator.ts` — `OneShotOrchestrator` constructor is
  `(inner, broker, gitNodes, sessionKey, taskId?)`. In `send()` (line ~111) it runs
  `yield* runBlueprint(blueprintFor(REPO_ONESHOT_PROFILE_ID), ctx, deps)` — the blueprint id is
  **hardcoded**.
- `src/oneshot/dispatching-factory.ts` — `create(sessionKey, profile)`: for `mode==='one-shot'`
  builds `inner` via the base factory with the conversational profile, then
  `return new OneShotOrchestrator(inner, this.broker, this.gitNodes, sessionKey)`.
- `src/sessions/manager.ts` — constructor already accepts `gateTimeoutMs?: number` (default
  `15 * 60 * 1000`). No config path feeds it yet.
- `src/config.ts` — `Config` has top-level `IDLE_TIMEOUT_MS` (via `optionalEnvNumber('IDLE_TIMEOUT_MS', 10*60*1000)`).
  No `GATE_TIMEOUT_MS` yet.
- `src/app.ts` — `buildGateway(deps)` constructs `new SessionManager({ idleTimeoutMs, factory,
  slack, store })`. `GatewayDeps` has `idleTimeoutMs` but no `gateTimeoutMs`.
- `src/index.ts` (line ~128) and `src/harness/cli.ts` (line ~96) both call `buildGateway({...})`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate passes. Make
every edit, add tests, run the gate, fix failures, then stop. Yielding after only exploring
(zero file changes) is a failure — implement end to end in this run.

## What to build

### 1. Profile: add the `planGate` facet + the supervised profile (`src/profiles/registry.ts`)
- Add `planGate: boolean;` to the `Profile` interface (a required field).
- Update both existing `PROFILES` entries to include `planGate: false`.
- Add a third entry:
  `['supervised-repo-oneshot', { id: 'supervised-repo-oneshot', label: 'Repo (supervised one-shot)', mode: 'one-shot', planGate: true }]`.
- Export `export const SUPERVISED_REPO_ONESHOT_PROFILE_ID = 'supervised-repo-oneshot';`.
- Keep `getProfile`'s never-throw fallback behaviour unchanged.
- Add a short doc comment noting `planGate` declares whether the profile's one-shot blueprint
  includes the plan-approval gate (the gate node itself lands in S03).

### 2. Blueprint: register a supervised blueprint (`src/oneshot/registry.ts` + new file)
- Create `src/oneshot/supervised-repo-oneshot.ts` exporting
  `export const supervisedRepoOneshot: OneShotBlueprint = { id: 'supervised-repo-oneshot', nodes: repoOneshot.nodes };`
  — i.e. **reuse `repoOneshot.nodes` verbatim**. Add a one-line comment: the node list is
  identical to the unsupervised blueprint until S03 inserts the `plan-gate` node after `planNode`.
- Register it: `BLUEPRINTS = [repoOneshot, supervisedRepoOneshot]`.
- `blueprintFor` is unchanged (it already looks up by id).

### 3. Orchestrator: select the blueprint by id, no longer hardcode (`src/oneshot/orchestrator.ts`)
- Add a constructor parameter `blueprintId` so the orchestrator runs the blueprint the profile
  selected. To avoid churning the ~30 existing test call sites that use the current 5-arg form,
  add it as a **trailing optional** parameter defaulting to the unsupervised blueprint:
  `(inner, broker, gitNodes, sessionKey, taskId?, blueprintId: string = REPO_ONESHOT_PROFILE_ID)`.
  Store it on a private field.
- In `send()`, replace the hardcoded `blueprintFor(REPO_ONESHOT_PROFILE_ID)` with
  `blueprintFor(this.blueprintId)`. Everything else (lease, revoke, ctx build) is unchanged.

### 4. Dispatching factory: pass the profile's id as the blueprint id (`src/oneshot/dispatching-factory.ts`)
- In the `mode === 'one-shot'` branch, pass the profile id through:
  `return new OneShotOrchestrator(inner, this.broker, this.gitNodes, sessionKey, undefined, profile.id);`
  (the `undefined` is the existing optional `taskId`). The convention is profile.id === blueprint
  id for one-shot profiles, which holds for both `repo-oneshot` and `supervised-repo-oneshot`.

### 5. Listener: trigger flip (`src/slack/listener.ts`)
- Change `parseOneShotTrigger` to recognize **both** `task` and `exec` and report which profile
  the trigger selects. New shape:
  ```ts
  export interface OneShotTrigger {
    profileId: string;
    text: string;
  }
  export function parseOneShotTrigger(stripped: string): OneShotTrigger | null {
    const match = /^(task|exec)\s+(.+)$/is.exec(stripped);
    if (match === null) return null;
    const keyword = (match[1] ?? '').toLowerCase();
    const text = match[2]?.trim() ?? '';
    if (text === '') return null;
    const profileId = keyword === 'task'
      ? SUPERVISED_REPO_ONESHOT_PROFILE_ID
      : REPO_ONESHOT_PROFILE_ID;
    return { profileId, text };
  }
  ```
  (Do NOT use `!` non-null assertions — use `?? ''` / `?.` like the surrounding code.)
- Import `SUPERVISED_REPO_ONESHOT_PROFILE_ID` from the profiles registry.
- Update `handleMention` to use the new shape:
  `const trigger = parseOneShotTrigger(stripped); const profileId = trigger?.profileId ?? DEFAULT_PROFILE_ID; const message = trigger?.text ?? stripped;`
- `handleMessage` (thread replies) is unchanged — it still enqueues with `DEFAULT_PROFILE_ID`.

### 6. Config: add `GATE_TIMEOUT_MS` and wire it through (`src/config.ts`, `src/app.ts`, `src/index.ts`, `src/harness/cli.ts`)
- `src/config.ts`: add top-level `GATE_TIMEOUT_MS: number;` to the `Config` interface, populated
  with `optionalEnvNumber('GATE_TIMEOUT_MS', 15 * 60 * 1000)` (default 15 min — matches the
  manager's own default). Place it next to `IDLE_TIMEOUT_MS`.
- `src/app.ts`: add `gateTimeoutMs?: number;` (optional) to `GatewayDeps`, and forward it to the
  `SessionManager` only when present, using the existing exactOptionalPropertyTypes-safe spread
  idiom: `...(deps.gateTimeoutMs !== undefined && { gateTimeoutMs: deps.gateTimeoutMs })`.
  (Optional so the two test `buildGateway` callers and the harness need not change unless they want to.)
- `src/index.ts`: pass `gateTimeoutMs: config.GATE_TIMEOUT_MS` in the `buildGateway({...})` call.
- `src/harness/cli.ts`: leave as-is (it omits idle/gate config tuning); no change required, but
  it must still compile.

## Acceptance criteria

1. `npm run check` passes (all existing tests keep passing, plus new ones) AND `npm run gate`
   passes (dependency-cruiser clean — no new boundary violations).
2. A `task github:acme/widgets fix the bug` mention creates a session with profile id
   `supervised-repo-oneshot`; an `exec github:acme/widgets fix the bug` mention creates one with
   `repo-oneshot`; a plain mention (`hello there`) uses `conversational`.
3. `getProfile('supervised-repo-oneshot')` returns `{ id, label: 'Repo (supervised one-shot)',
   mode: 'one-shot', planGate: true }`; `repo-oneshot` and `conversational` both have
   `planGate: false`.
4. The `DispatchingRunnerFactory` returns a `OneShotOrchestrator` for the
   `supervised-repo-oneshot` profile, and that orchestrator runs the `supervised-repo-oneshot`
   blueprint (verifiable via a `FakeRunner`/fake git nodes run that reaches the same node
   sequence — for S02 the supervised blueprint is node-identical to the unsupervised one, so an
   end-to-end happy-path run still opens a PR).
5. New/updated tests:
   - `test/profiles.test.ts`: supervised profile entry + `planGate` values.
   - `test/listener.test.ts`: update the `parseOneShotTrigger` unit tests to the new
     `{ profileId, text }` shape; add `exec` cases; add a mention test asserting the
     `supervised-repo-oneshot` profile id reaches the factory/store for `task` and `repo-oneshot`
     for `exec`.
   - `test/oneshot.test.ts`: add a `DispatchingRunnerFactory` case for the supervised profile.
   - `test/config.test.ts` (if present — otherwise wherever config is tested): `GATE_TIMEOUT_MS`
     default + override. If there is no config test file, add a minimal one.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`, no `!` non-null assertions**;
  `NodeNext` ESM (`.js` import specifiers); `exactOptionalPropertyTypes` is on — guard optional
  forwarding with the spread idiom shown above.
- Inject external dependencies; tests stay offline (no Slack/Docker/API/network) and use the
  existing fakes (`FakeSlackClient`, `FakeRunner`, `FakeBroker`, fake git nodes).
- Do NOT touch `protocol.ts` (this slice doesn't change the gateway↔runner contract).
- Never log message contents or tokens.
- Do NOT add dependencies.
- Do NOT commit — leave the working tree for review.

## Invariants this slice touches (boundary-enforced — design with them)
- `@slack/bolt` only in `src/index.ts`; the gateway never imports the Agent SDK or `runner/`.
  (You're editing `listener.ts`, `app.ts`, `config.ts`, `index.ts`, `oneshot/*` — none should
  add a Bolt or Agent-SDK import.)
- The gateway never runs agent code; nothing here executes model-decided work on the host.

## Out of scope (do NOT build)
- The `plan-gate` blueprint node and any actual parking/`await_approval` emission — that is **S03**.
- Gate **authorization** (requestor-only resolve) and **reply-as-data** delimiting — also S03
  (flagged in `manager.ts` `enqueueExisting`). Do not touch that comment's deferred items.
- Durable park across restarts — deferred (post-M6).
- Any change to `handleMessage` thread-reply routing.

## When done — report precisely (with REAL command output)
- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased) — both `check` and `boundaries`.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
