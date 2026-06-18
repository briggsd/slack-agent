# Task: M5 tooling — fake Slack adaptor + composition root + CLI driver + integration test

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-m5-fake-slack-harness`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m5-fake-slack-harness`.

## What this slice is

A **fake Slack adaptor** that drives the *real* gateway end-to-end without Slack, plus
the small refactor that makes it possible. It pays off two ways:

1. **Offline CI integration test** (with `FakeRunnerFactory`) — feeds synthetic Slack
   events through the real `listener → SessionManager → responder → runner` wiring and
   asserts on captured Slack output. This closes the one real coverage gap: the
   gateway composition is currently exercised by nothing, because it lives in
   `src/index.ts`, the only Bolt-importing (and therefore un-unit-tested) file.
2. **Manual end-to-end smoke** (with the real `DockerRunnerFactory`) — a local
   "headless Slack" REPL: type a message, watch a real container answer, stream, and
   forward files. Fast iteration, no Slack round-trip.

The architecture already supports this: `src/index.ts` is the only file importing
Bolt, and everything below it takes injected interfaces. We extract the
transport-agnostic wiring into a shared composition root that both the real Bolt edge
and the fake adaptor call.

## Context — read before writing code

- **`src/index.ts`** — the current wiring (the thing we factor). Bolt-specific parts:
  `new App()`, the `auth.test` call, the `SlackClientLike` wrapper over `app.client`,
  `registerSlackHandlers(app, …)`, `app.start()`. Everything else (store, factory,
  `SessionManager`) is transport-agnostic.
- **`src/slack/listener.ts`** — `registerSlackHandlers(app: BoltAppLike, deps:
  HandlerDeps)` registers `'app_mention'` and `'message'` handlers via
  `app.event(type, async ({ body }) => …)`. `BoltAppLike` is
  `{ event(type: string, handler: (args: { body: unknown }) => Promise<void>): void }`
  — **currently NOT exported; export it** so the fake app can be typed against it. The
  event body shapes are the exported `MentionEventBody` / `MessageEventBody`. Note the
  session key is `${team}:${channel}:${thread_ts ?? ts}` and mentions are stripped of
  `<@botUserId>`.
- **`src/slack/responder.ts`** — `SlackClientLike` (`postMessage` → `{ts}`, `update`,
  `uploadFile`). The placeholder text is `_thinking…_`.
- **`src/sessions/manager.ts`** — `new SessionManager({ idleTimeoutMs, factory, slack,
  store? })`; `enqueueNew(key, item)` (app_mention; auto-creates) and
  `enqueueExisting(key, item)` (thread reply; returns `false` if no session). Draining
  is async/fire-and-forget — see Test infrastructure for how to await it.
- **Precedent to mirror — the capturing client:** `test/responder.test.ts` defines a
  `FakeSlackClient implements SlackClientLike` with public `posts` / `updates` /
  `uploads` arrays. Your `CapturingSlackClient` is the same idea, but lives in `src/`
  (so the CLI can use it too) and additionally **echoes to the console** when run
  interactively.
- **Run tooling:** `tsc` → `dist/`, then `node`. `start` is
  `node --env-file=.env dist/index.js`. Your CLI script mirrors that.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end.

## What to build

### 1. Export `BoltAppLike` (in `src/slack/listener.ts`)
Add `export` to the existing `interface BoltAppLike`. No other change to listener.ts.

### 2. Composition root — `src/app.ts`
Extract the transport-agnostic wiring into one function both edges call:
```ts
export interface GatewayDeps {
  app: BoltAppLike;            // real Bolt app OR the fake app
  slack: SlackClientLike;      // real wrapper OR CapturingSlackClient
  factory: RunnerFactory;
  store: SessionStore;
  idleTimeoutMs: number;
  botUserId: string;
}
export function buildGateway(deps: GatewayDeps): { sessions: SessionManager } {
  const sessions = new SessionManager({
    idleTimeoutMs: deps.idleTimeoutMs, factory: deps.factory,
    slack: deps.slack, store: deps.store,
  });
  registerSlackHandlers(deps.app, { sessions, slack: deps.slack, botUserId: deps.botUserId });
  return { sessions };
}
```
`src/app.ts` must NOT import `@slack/bolt` (it takes `app` as `BoltAppLike`).

### 3. Refactor `src/index.ts` to call `buildGateway` (behavior-preserving)
Replace the inline `new SessionManager(...)` + `registerSlackHandlers(...)` with a
`buildGateway({ app, slack, factory, store, idleTimeoutMs: config.IDLE_TIMEOUT_MS,
botUserId })` call. **Keep everything else identical** — the Bolt `App`, `auth.test`,
the `slack` wrapper, store open + SIGTERM/SIGINT handlers, the factory selection, and
`app.start()`. `index.ts` stays the ONLY file importing Bolt. This is a pure
refactor; no behavior change.

### 4. The fake adaptor — `src/harness/fake-slack.ts`
- **`CapturingSlackClient implements SlackClientLike`** — public `posts` / `updates` /
  `uploads` arrays (mirror `FakeSlackClient`); `postMessage` returns an incrementing
  `ts`. Add a constructor flag `{ echo?: boolean }` (default false): when `echo` is
  true, print each post/update/upload to the console in a readable form (the CLI uses
  this; tests leave it off).
- **`FakeSlackApp implements BoltAppLike`** — records handlers registered via
  `event(type, handler)` in a map, and exposes:
  - `async fireMention(args: { team?: string; channel: string; threadTs?: string;
    user?: string; text: string; ts: string }): Promise<void>` — build a
    `MentionEventBody` and invoke the `'app_mention'` handler with `{ body }`.
  - `async fireReply(args: { team?: string; channel: string; threadTs: string;
    user?: string; text: string; ts: string }): Promise<void>` — build a
    `MessageEventBody` and invoke the `'message'` handler.
  These let a driver inject events without constructing raw envelopes. Awaiting them
  runs the handler (which enqueues); see Test infrastructure for awaiting the drain.

### 5. The CLI driver — `src/harness/cli.ts`
A small REPL (`node:readline`) that:
- loads config/env (reuse `loadConfig`; tolerate a missing Slack token path — see
  note), picks the factory from `RUNNER_BACKEND` exactly like `index.ts`
  (`docker` → real `DockerRunnerFactory`, else `FakeRunnerFactory`), opens a store
  (use an in-memory/temp `SqliteSessionStore` path or `NoopSessionStore` — simplest
  that works), and a fixed fake `botUserId` (e.g. `'UHARNESS'`).
- calls `buildGateway({ app: fakeApp, slack: capturingClient(echo:true), … })`.
- REPL loop: maintain a current `channel`/`threadTs`. First message → `fireMention`
  (creates the session); subsequent lines in the same thread → `fireReply`. Print the
  captured Slack output (the `echo:true` client handles this). Provide a tiny help
  banner and a way to start a new thread (e.g. a `/new` command) and quit
  (`/quit`).
- **Config note:** `loadConfig` requires `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`. The
  harness doesn't need them. Either set placeholders in `.env`, or have the CLI read
  only the fields it needs (idle timeout, runner backend, db path) without requiring
  the Slack tokens. Pick the smaller change; do NOT weaken `loadConfig` for the real
  gateway. (A clean option: the CLI builds its own minimal config object from
  `process.env` with sensible defaults, not via `loadConfig`.)
- Add an npm script: `"harness": "node --env-file=.env dist/harness/cli.js"` (mirror
  `start`). Note in the script/PR that it needs `npm run build` first and, for real
  smoke, `RUNNER_BACKEND=docker` + `ANTHROPIC_API_KEY` + a built runner image.

The CLI's interactive loop (readline/process) is not unit-tested — keep the logic thin
and push everything testable into `fake-slack.ts` / `buildGateway`.

### 6. Offline integration test — `test/harness-integration.test.ts`
The Tier-1 payoff. Using `buildGateway` + `FakeRunnerFactory` + `CapturingSlackClient`
(echo off) + `FakeSlackApp` + a store (`NoopSessionStore` is fine), exercise the real
wiring end to end, offline:
1. **Mention → answer.** `fireMention({ channel:'C', threadTs:'T1', user:'U1',
   text:'<@UHARNESS> hello world', ts:'T1' })`, wait for the drain, then assert the
   `CapturingSlackClient` recorded the `_thinking…_` placeholder post and an `update`
   containing the echoed reply (`FakeRunner` default emits `Echo: <message>`, so the
   stripped message `hello world` → `Echo: hello world`). Use `botUserId:'UHARNESS'`.
2. **Thread reply routes to the same session.** After the mention, `fireReply` in the
   same thread → another `Echo:` update; assert it landed.
3. **Reply with no session is ignored.** `fireReply` in an unknown thread → no new
   placeholder/update beyond the prior ones.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner check + vitest) **and**
   `npm run boundaries`. All existing tests still pass; new ones added.
2. `BoltAppLike` is exported; `src/app.ts` `buildGateway` exists and is used by
   `src/index.ts`; `index.ts` still imports Bolt and is the only file that does;
   gateway runtime behavior is unchanged (pure refactor).
3. `src/harness/fake-slack.ts` exports `CapturingSlackClient` and `FakeSlackApp` with
   the `fireMention`/`fireReply` helpers.
4. `src/harness/cli.ts` exists and an `npm run harness` script is added.
5. `test/harness-integration.test.ts` covers the three flows above through
   `buildGateway` and the fakes, offline.

## Test infrastructure (how to test this — do not skip)

- Tests live in `test/`, run under **vitest**, **offline** (no Slack/Docker/API/network).
- **Awaiting the async drain:** the manager drains fire-and-forget. The existing
  `test/manager.test.ts` waits with `await new Promise((r) => setTimeout(r, 20))` after
  an enqueue — mirror that after each `fire…` call before asserting on
  `CapturingSlackClient` arrays. (Do not switch the file to fake timers; a short real
  wait matches the manager-test precedent and keeps it simple.)
- **Assertions:** `CapturingSlackClient.posts` (placeholder), `.updates` (streamed +
  final text), `.uploads` (files). `FakeRunner`'s default turn is a `status` then
  `text: 'Echo: <message>'` — assert the final update contains `Echo: hello world`.
- Reuse the existing fakes; do not mock Bolt or the network.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **real tail** (with pass/fail counts).
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers). Honor
  `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`.
- **`@slack/bolt` stays imported ONLY in `src/index.ts`.** `src/app.ts`,
  `src/harness/*`, and tests must not import it (`npm run boundaries` enforces this).
  Do not import the Agent SDK or the `runner/` package from `src/` either.
- **Never log message contents or tokens.** The `echo` console output in the CLI is a
  deliberate, opt-in dev affordance (off in tests, off by default) — it is the one
  place message text is printed, and only in the interactive harness; do not add
  content logging anywhere else, and keep `echo` default false.
- The `index.ts` change is a **behavior-preserving refactor** — do not change the
  gateway's runtime behavior, env handling, or lifecycle.
- Keep the diff focused: the listener export, `src/app.ts`, the `index.ts` refactor,
  `src/harness/*`, the npm script, and the integration test. No unrelated refactors.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- Driving the **one-shot / `repo-oneshot`** path — it isn't wired to the entry point
  until S05; the harness drives the conversational path now and will reach one-shot
  for free once S05 lands.
- Any real Docker/Slack/network call in the **test** suite (the CLI may use the real
  Docker backend when a human runs it; the gate stays offline).
- Scripted/automated assertion mode for the CLI, recording/replay — not now.

## When done — report precisely (with REAL command output)

Run and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the
full `npm run gate` tail (with pass/fail counts). Do not describe any change you cannot
point to in `git diff` — especially `test/harness-integration.test.ts`. Then: (1)
files added/changed, one line each; (2) how you kept the `index.ts` change
behavior-preserving; (3) how the integration test awaits the drain and what it
asserts; (4) anything you could not satisfy and why. Note that you verified the CLI
only by reasoning/types (it is not in the gate), and what a human should run to smoke
it (`npm run build && npm run harness`).
