# Task: M5 S02 — one-shot orchestrator (SessionRunner) + profile dispatch + minimal blueprint

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-m5-s02-oneshot-orchestrator`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m5-s02-oneshot-orchestrator`.

## What this slice is

The second M5 slice. It realizes the **gateway-side one-shot orchestrator**: a
`SessionRunner` that runs a *minimal blueprint* (clone → implement → push → open PR)
by **composing** an inner agent runner for the agentic step and calling deterministic
**git nodes** for the credentialed steps. Everything here runs against **fakes**
(`FakeBroker` from S01, a new `FakeGitNodeExecutor`, and the existing
`FakeRunnerFactory`) — **fully offline, no Docker/network/API**. The real git-node
executor (clone/push/PR over Docker + REST) is **S03**; live wiring into the running
gateway + config is **S05**.

The architecture (decided in design `0004`): the agent container does **agentic work
only and holds no credential**; the credential is leased on the trusted side and used
only by the deterministic git nodes. The orchestrator runs trusted-side and is itself
a `SessionRunner`, so the session manager, listener, and NDJSON protocol are
unchanged.

## Context — read before writing code

- **S01 just landed the credential broker** (on `main`, in this worktree):
  - `src/broker/types.ts` — `GitHost` (`'github' | 'gitlab'`), `LeaseRequest`
    (`{ host, repo, taskId }`), `CredentialLease` (`{ readonly token, readonly host,
    readonly repo, revoke(): Promise<void> }`), `CredentialBroker` (`lease(req):
    Promise<CredentialLease>`).
  - `src/broker/fake.ts` — `FakeBroker`: records `leases: LeaseRequest[]` and
    `revokes: LeaseRequest[]`; `lease()` returns a lease whose `revoke()` pushes onto
    `revokes`. **Use this in your orchestrator tests.**
  Read both files before starting.
- **The runner seam you compose and mirror:**
  - `src/runner/types.ts` — `SessionRunner` (`send(message): AsyncIterable<RunnerEvent>`,
    `dispose(): Promise<void>`), `RunnerEvent` (`{type:'status',text}` | `{type:'file',
    name,data}` | `{type:'text',text}` | `{type:'error',message}`), `RunnerFactory`
    (`create(sessionKey, profile): Promise<SessionRunner>`).
  - `src/runner/fake.ts` — `FakeRunner` / `FakeRunnerFactory` (records `creates`,
    `profiles`, `runners`; `FakeRunner.sends: string[]`, scripted turns). **This is
    the precedent for how an inner agent runner behaves and how to drive it.**
  - `src/runner/docker.ts` — `DockerRunnerFactory.create(sessionKey, _profile)` is the
    real agent factory you'll dispatch to for the conversational path (don't modify it).
- **The profile seam you extend:** `src/profiles/registry.ts` — `Profile` is currently
  `{ id, label }` with one `conversational` entry; `getProfile(id)` falls back to
  default. `src/sessions/manager.ts:64` resolves the profile and calls
  `factory.create(sessionKey, profile)`. `src/slack/listener.ts` always sets
  `profileId: DEFAULT_PROFILE_ID` — so the one-shot path is **unreachable at runtime
  until S05**; that is why this slice does not wire into `index.ts`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end.

## What to build — shapes pinned (follow these; structure files sensibly under `src/oneshot/`)

### 1. Extend `Profile` with a `mode` (in `src/profiles/registry.ts`)
- Add `mode: 'conversational' | 'one-shot'` to the `Profile` interface (required field).
- Set the existing `conversational` entry's `mode: 'conversational'`.
- Add a second entry: `{ id: 'repo-oneshot', label: 'Repo (one-shot)', mode: 'one-shot' }`.
- Adding a required field will break any `Profile` literal that omits it — there is
  one in `test/profiles.test.ts` (~line 43). Fix it (add `mode`) and add/adjust an
  assertion that the registry now contains `repo-oneshot` with `mode: 'one-shot'`.
  Grep for `Profile` to be sure you caught every literal.

### 2. The git-node seam — `GitNodeExecutor` (interface only; real impl is S03)
Define an interface for the deterministic, credentialed git operations. The
orchestrator depends on this interface; S03 supplies the real Docker/REST impl.
```ts
import type { CredentialLease } from '../broker/types.js';

export interface CloneRequest { lease: CredentialLease; repo: string; workdir: string }
export interface PushRequest  { lease: CredentialLease; repo: string; branch: string; workdir: string }
export interface OpenChangeRequest {
  lease: CredentialLease; repo: string; head: string; base: string; title: string; body: string;
}

/** Deterministic, credentialed git operations. Run trusted-side; never in the agent sandbox. */
export interface GitNodeExecutor {
  clone(req: CloneRequest): Promise<void>;
  push(req: PushRequest): Promise<void>;
  openChangeRequest(req: OpenChangeRequest): Promise<{ url: string }>;
}
```

### 3. A `FakeGitNodeExecutor` (test double — mirror `FakeRunnerFactory`'s recording style)
- Public arrays recording each call in order: `clones: CloneRequest[]`,
  `pushes: PushRequest[]`, `changeRequests: OpenChangeRequest[]`.
- `openChangeRequest` returns a scripted URL (constructor arg, default e.g.
  `'https://example.test/pr/1'`).
- Optional: allow a method to be scripted to reject, so a test can exercise a
  git-node failure path (see tests below). Keep it simple.

### 4. A minimal task parser — `parseOneShotTask(message: string)`
The `SessionRunner.send()` contract takes a `string`. For this slice, parse a
**minimal** grammar; the friendly entry UX (channel binding, nice errors) is S05.
- Grammar: the message must start with `"<host>:<owner>/<repo>"` followed by
  whitespace then the instruction. Example: `github:acme/widgets add a CHANGELOG`.
- Return `{ host: GitHost; repo: string; instruction: string }` on success, or
  `null` (or a discriminated `{ ok: false }`) on a malformed message / unknown host.
- `host` must be one of the `GitHost` values; anything else → parse failure.
- Keep `repo` as the `"owner/name"` slug.

### 5. `OneShotOrchestrator implements SessionRunner`
Constructed with its dependencies (all injected): the **ready inner agent runner**, a
`CredentialBroker`, a `GitNodeExecutor`, and a `taskId` (or generate one — see note).
`send(message)` runs the minimal blueprint and yields events:
1. Parse the message (`parseOneShotTask`). On failure → `yield { type:'error',
   message: <clear reason> }` and return (no lease, no git calls).
2. `lease = await broker.lease({ host, repo, taskId })`.
3. `yield { type:'status', text:'cloning repository…' }`; `await gitNodes.clone({
   lease, repo, workdir })` (workdir: a fixed per-task path, e.g.
   `/workspace/<repo-slug>` — it's passed through to the fake here).
4. `yield { type:'status', text:'implementing…' }`; drive the **inner agent runner**:
   `for await (const ev of inner.send(instruction)) { ... }` — forward its `status`
   events as your own `status` events; capture its final `text` as the implement
   result; if the inner emits `error`, treat it as a blueprint failure (see failures).
5. `yield { type:'status', text:'pushing branch…' }`; `await gitNodes.push({ lease,
   repo, branch, workdir })` (branch: a generated name, e.g.
   `slackbot/oneshot-<taskId>`).
6. `yield { type:'status', text:'opening pull request…' }`; `const { url } = await
   gitNodes.openChangeRequest({ lease, repo, head: branch, base: 'main', title, body
   })` (title: first line / first ~72 chars of the instruction; body: short, derived
   — do NOT include any token or secret).
7. `await lease.revoke()` (always attempt revoke once a lease exists — see failures).
8. `yield { type:'text', text: \`Opened PR: ${url}\` }` (terminal).
- `dispose()` disposes the inner runner (`await inner.dispose()`); idempotent.
- **taskId:** generate it (mirror `docker.ts`'s correlation id style: `${Date.now()}-${random}`)
  or accept it injected. Either is fine; keep it out of logs-with-content.

**Failure handling (minimal but correct):**
- If a step **after** the lease is acquired throws (git node rejects, or inner agent
  emits `error`), still `await lease.revoke()` before yielding the terminal
  `{ type:'error', message }`. Use try/finally or equivalent so a lease is never left
  un-revoked. (`revoke()` for the interim token is a no-op, but the orchestrator must
  call it — that's the contract S03/the App impl rely on.)
- Never include the lease token in any status/error/text/log. (Invariant: never log
  tokens.)

### 6. `DispatchingRunnerFactory implements RunnerFactory`
Wraps a **base agent factory** and the one-shot dependencies; dispatches on
`profile.mode`:
```ts
constructor(
  private agentFactory: RunnerFactory,       // the real/fake agent factory (Docker/Fake)
  private broker: CredentialBroker,
  private gitNodes: GitNodeExecutor,
) {}

async create(sessionKey: string, profile: Profile): Promise<SessionRunner> {
  if (profile.mode === 'one-shot') {
    // Create the inner agent runner with an AGENT profile (NOT the one-shot profile)
    // using the BASE factory — so there is no dispatch recursion.
    const inner = await this.agentFactory.create(sessionKey, getProfile('conversational'));
    return new OneShotOrchestrator(inner, this.broker, this.gitNodes /*, taskId */);
  }
  return this.agentFactory.create(sessionKey, profile);
}
```
The recursion-avoidance point is load-bearing: the orchestrator's inner runner is made
by the **base** factory with the **conversational** profile, never by the dispatching
factory and never with the one-shot profile.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner check + vitest) **and**
   `npm run boundaries`. All existing tests still pass; new ones added.
2. `Profile` has a required `mode`; registry has `conversational` (`'conversational'`)
   and `repo-oneshot` (`'one-shot'`); `test/profiles.test.ts` updated and green.
3. `GitNodeExecutor` + request types exist; `FakeGitNodeExecutor` records
   `clones`/`pushes`/`changeRequests` and returns a scripted PR url.
4. `parseOneShotTask` parses `"<host>:<owner>/<repo> <instruction>"` and rejects
   malformed / unknown-host input.
5. `OneShotOrchestrator` (a `SessionRunner`) runs the blueprint in order against the
   fakes: leases → clone → inner.send(instruction) → push → openChangeRequest →
   revoke → terminal `text` with the PR url; forwards inner `status` events; on a
   post-lease failure it revokes then emits `error`; on parse failure it emits `error`
   with no lease/git calls; `dispose()` disposes the inner runner.
6. `DispatchingRunnerFactory` returns a `OneShotOrchestrator` for a `one-shot` profile
   and delegates to the base factory for a `conversational` profile (no dispatch
   recursion).
7. New tests cover criteria 4–6 (see below).

## Test infrastructure (how to test this — the hard part, do not skip)

Tests live in `test/`, run under **vitest**, offline. Create `test/oneshot.test.ts`
(and extend `test/profiles.test.ts` for the `mode`/registry change). Use the existing
and S01 fakes — do **not** invent new world-mocks:
- **Inner agent runner:** `FakeRunnerFactory` / `FakeRunner` (`src/runner/fake.ts`).
  Pass a `FakeRunnerFactory` as the base factory to `DispatchingRunnerFactory`, or a
  `FakeRunner` directly to `OneShotOrchestrator`. Script the inner turn with
  `RunnerEvent[]` (e.g. a `status` then a `text`) and assert the orchestrator forwards
  the status and captures the text. `FakeRunner.sends` lets you assert the instruction
  reached the inner runner.
- **Broker:** `FakeBroker` (`src/broker/fake.ts`) — assert `fake.leases` recorded the
  `{host,repo,taskId}` and `fake.revokes` recorded the revoke (including on the
  failure path).
- **Git nodes:** your `FakeGitNodeExecutor` — assert call order and arguments
  (`clones`/`pushes`/`changeRequests`), and that the PR url reaches the terminal text.
- **Collecting events:** drain `for await (const ev of orch.send(msg))` into an array
  and assert on the sequence (status texts in order, terminal text/error).

Cover at minimum:
1. Happy path: full ordered blueprint, terminal text contains the scripted PR url,
   `leases` + `revokes` both recorded once, inner received the instruction.
2. Parse failure: malformed message → single `error` event, **no** lease, **no** git
   calls (`fake.leases` empty, executor arrays empty).
3. Post-lease failure: script `FakeGitNodeExecutor.push` (or `openChangeRequest`) to
   reject → orchestrator still revokes (`fake.revokes` length 1) then yields `error`.
4. Inner-agent error: script the inner turn to emit `{type:'error'}` → orchestrator
   revokes then yields `error` (no push / no PR).
5. Dispatch: `DispatchingRunnerFactory.create` with the `repo-oneshot` profile returns
   a `OneShotOrchestrator`; with `conversational` returns the base fake runner (assert
   the base `FakeRunnerFactory.creates`/`profiles` recorded the right profile, and that
   for one-shot the inner was created with the conversational profile — no recursion).
6. `dispose()` disposes the inner runner (`FakeRunner.disposed === true`).

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **real tail** (with pass/fail counts).
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers). Honor
  `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`.
- **Never log or emit a token** in any status/error/text/log line.
- `src/` must not import `@slack/bolt`, the Agent SDK, or `runner/`
  (`npm run boundaries` enforces it). The orchestrator drives the inner runner only
  through the `SessionRunner` interface — never the SDK directly.
- **Do NOT wire into the live gateway:** do not modify `src/index.ts`,
  `src/sessions/manager.ts`, `src/slack/listener.ts`, `src/config.ts`,
  `src/runner/docker.ts`, or `protocol.ts`. The dispatch + orchestrator are exercised
  by unit tests only this slice; live wiring + config tokens are S05. (You DO modify
  `src/profiles/registry.ts` and `test/profiles.test.ts` for the `mode` field.)
- Keep the diff focused: new files under `src/oneshot/`, the registry `mode` change,
  and the two test files. No unrelated refactors.
- Match surrounding style (see `src/runner/fake.ts`, `src/profiles/registry.ts`).
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — later slices)

- Real `GitNodeExecutor` (Docker clone/push + REST open-PR/MR) — **S03**.
- `GitHostProvider` / `cloneUrl` (host-specific URL + REST plumbing) — S03.
- Live wiring into `index.ts`, config broker-token env, channel→profile selection,
  friendly trigger parsing / error UX — **S05**.
- Research→plan→implement (multi-step agentic), lint/test nodes, failure classifier,
  bounded iteration, diff/file forwarding — **S04**. This slice's blueprint is the
  minimal clone → single implement → push → PR.

## When done — report precisely (with REAL command output)

Run and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the
full `npm run gate` tail (with pass/fail counts). Do not describe any change you cannot
point to in `git diff` — especially `test/oneshot.test.ts`. Then: (1) files
added/changed, one line each; (2) non-obvious choices (taskId, workdir/branch naming,
how you avoided dispatch recursion); (3) which test covers each acceptance criterion
4–6; (4) anything you could not satisfy and why.
