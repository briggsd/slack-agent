# Task: M5 S01 — credential-broker seam + interim bot-account provider + FakeBroker

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-haiku-m5-s01-broker-seam`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`haiku/m5-s01-broker-seam`.

This is a **pure additive seam — no behavior change**. You create one new module
(`src/broker/`) plus tests. You do **not** touch any existing runtime file
(`config.ts`, `index.ts`, listener, sessions, runner). Nothing consumes the broker
yet — that wiring is a later slice (S02). The slice's whole job is to land the
credential-brokering *interface* and an interim implementation, the same seam-first
discipline M4 used.

## Context — read before writing code

- **Design intent (the *why*):** the M5 grounding note decided a **gateway-side,
  host-agnostic credential broker**: the git credential is leased on the trusted
  side and **never enters the agent sandbox**. The interim provider is a **bot
  service account** (not a GitHub App yet) because **GitLab support is wanted
  later** and a per-host bot token works uniformly across hosts. A static interim
  token has no per-task mint/revoke, so `revoke()` is a no-op for it; the protection
  that still holds is that the token never reaches the agent container. (You don't
  have `design/` in this worktree — it's gitignored. All facts you need are inlined
  here.)
- **Precedent to mirror (most valuable):** `src/runner/fake.ts` — `FakeRunner` /
  `FakeRunnerFactory`. Copy its shape for `FakeBroker`: a class implementing the
  interface, with **public arrays recording calls** (`creates`, `profiles`,
  `runners`) so tests assert against them. Your `FakeBroker` mirrors this exactly.
- **Style precedent for the interim impl + a readonly registry:**
  `src/profiles/registry.ts` — `ReadonlyMap` usage, the "unknown id → graceful
  fallback/throw" pattern, doc-comment density. Match it.
- **Strict-TS facts that will bite:** `noUncheckedIndexedAccess` is on — a
  `Map.get()` / index lookup returns `T | undefined`, so the unconfigured-host path
  must handle `undefined` (throw a clear error). `exactOptionalPropertyTypes` is on.
  **No `any`, no `@ts-ignore`.**

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this
run.

## What to build — exact shapes (transcribe these; do not redesign)

### `src/broker/types.ts`
```ts
/** A git host the broker can lease credentials for. Open set; gitlab is the planned second. */
export type GitHost = 'github' | 'gitlab';

/** A request to lease a credential for one task, scoped to a host + repo. */
export interface LeaseRequest {
  host: GitHost;
  /** "org/name" slug. */
  repo: string;
  /** Correlates the lease with the one-shot task that owns it (audit trail, M6). */
  taskId: string;
}

/**
 * A leased credential. Handed only to trusted-side deterministic git nodes
 * (never to the agent sandbox). `revoke()` ends the lease — a real revoke for
 * short-lived App tokens (future), a no-op for a static interim bot-account token.
 */
export interface CredentialLease {
  readonly token: string;
  readonly host: GitHost;
  readonly repo: string;
  revoke(): Promise<void>;
}

/** Leases per-task git credentials on the trusted side. */
export interface CredentialBroker {
  lease(req: LeaseRequest): Promise<CredentialLease>;
}
```

### `src/broker/bot-account.ts`
`BotAccountBroker implements CredentialBroker` — the interim provider.
- Constructor takes the per-host bot tokens **by injection** (do not read
  `process.env` here — config wiring is S02): `constructor(tokens: ReadonlyMap<GitHost, string>)`.
- `lease({ host, repo, taskId })`:
  - look up the token for `host`; if absent (`undefined`), **throw** an `Error` with
    a clear message naming the host (e.g. `no bot-account token configured for host
    "gitlab"`). Do **not** include any token value in the message.
  - otherwise return a `CredentialLease` whose `token` is the configured token,
    `host`/`repo` echo the request, and `revoke()` is `async () => {}` (no-op:
    a static token has no per-task lifecycle).
  - `taskId` is accepted but unused for now (the static token has no per-task
    minting). That's fine — it's there for the App-token future and the audit trail.
- Add a concise doc-comment explaining the interim/no-op-revoke tradeoff (one short
  paragraph, matching the registry.ts comment density).

### `src/broker/fake.ts`
`FakeBroker implements CredentialBroker` — for tests, mirroring `FakeRunnerFactory`:
- `public leases: LeaseRequest[] = []` — every `lease()` request, in order.
- `public revokes: LeaseRequest[] = []` — pushed when a returned lease's `revoke()`
  is called (so tests can assert revoke happened and for which request).
- Constructor takes an optional fixed token to hand back (default e.g.
  `'fake-token'`): `constructor(token = 'fake-token')`.
- `lease(req)` records `req`, returns a `CredentialLease` with that token, echoed
  `host`/`repo`, and a `revoke()` that pushes `req` onto `this.revokes`.

(Optional convenience: a `src/broker/index.ts` barrel re-exporting the three files.
Only if it reads cleanly — not required.)

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner check + vitest) **and**
   `npm run boundaries` (dependency-cruiser). All existing tests still pass; new ones added.
2. `src/broker/types.ts` exports `GitHost`, `LeaseRequest`, `CredentialLease`,
   `CredentialBroker` with the exact shapes above.
3. `src/broker/bot-account.ts` exports `BotAccountBroker` implementing
   `CredentialBroker`: returns the configured token for a known host; **throws**
   (no token value in the message) for an unconfigured host; `revoke()` is a safe no-op.
4. `src/broker/fake.ts` exports `FakeBroker` implementing `CredentialBroker`,
   recording `leases` and `revokes` like `FakeRunnerFactory` records its calls.
5. New tests in `test/broker.test.ts` (see below) cover all of the following.

## Test infrastructure (how to test this — do not skip or thin out)

Tests live in `test/` and run under **vitest**, offline (no Slack/Docker/API/network).
Create `test/broker.test.ts`. No fakes-of-the-world needed — the broker is pure.
Mirror the assertion style of existing `test/*.ts`. Cover, at minimum, these cases:

1. **`BotAccountBroker.lease` returns the configured token** for a host present in
   the map; the returned lease's `host`/`repo` echo the request.
2. **Unconfigured host throws** — `lease({ host: 'gitlab', ... })` with no gitlab
   token rejects/throws an `Error`; assert the message names the host and **does not
   contain the configured token string** (use a recognizable token value and assert
   `expect(message).not.toContain(tokenValue)`).
3. **`revoke()` is a safe no-op** — calling it resolves and does not throw; the lease
   is still readable afterward.
4. **`FakeBroker` records lease requests** — after two `lease()` calls,
   `fake.leases` has both `LeaseRequest`s in order; the returned token is the fake's.
5. **`FakeBroker` tracks revoke** — calling a returned lease's `revoke()` pushes its
   request onto `fake.revokes`.

(Async note: `lease()` returns a `Promise`; assert the throw with
`await expect(broker.lease(...)).rejects.toThrow(...)` and capture the message via a
try/catch or `.rejects.toThrowError`.)

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **real tail** (with pass/fail counts) when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (use `.js` import specifiers, e.g.
  `import type { GitHost } from './types.js'`). Honor `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes`.
- **Never put a token value in a log line or an error message.** (Invariant: never
  log tokens.)
- The broker module is gateway-side (`src/`) — it must **not** import `@slack/bolt`,
  the Agent SDK (`@anthropic-ai/claude-agent-sdk`), or anything from `runner/`.
  (`npm run boundaries` enforces this.)
- Inject dependencies (the token map) via constructor — do not read `process.env`.
- Keep the diff to **new files only**. Do NOT edit `src/config.ts`, `src/index.ts`,
  or any existing runtime/test file. Do NOT do unrelated refactors.
- Match surrounding code style (naming, comment density, idiom) — see
  `src/runner/fake.ts` and `src/profiles/registry.ts`.
- Do NOT commit — leave the working tree for the coordinator to review.

## Out of scope (do NOT build — later slices)

- **`GitHostProvider` / `cloneUrl` / `openChangeRequest`** (clone/push/PR operations)
  — that's S03 (real deterministic git nodes).
- **Config wiring** (`GITHUB_BOT_TOKEN` etc. into `loadConfig`) and **instantiating
  the broker** anywhere — that's S02 (orchestrator wiring).
- The one-shot orchestrator, the `repo-oneshot` profile, the blueprint — S02+.
- Any real GitHub/GitLab REST or network call.

## When done — report precisely (with REAL command output)

Run and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the
full `npm run gate` tail (with pass/fail counts). Do not describe any change you
cannot point to in `git diff` — especially the `test/broker.test.ts` file (confirm it
appears in `git diff --stat`). Then: (1) files added, one line each; (2) any
non-obvious choice; (3) which test covers each acceptance criterion; (4) anything you
could not satisfy and why.
