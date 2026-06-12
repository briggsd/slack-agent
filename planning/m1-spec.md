# Task: M1 — Slack gateway skeleton (Bolt Socket Mode + session manager + fake runner)

You are implementing milestone 1 of a greenfield project in `/home/jedanner/workspace/slackbot`
(TypeScript, Node 20+, ESM `"type": "module"`, vitest, strict tsc, no bundler — `tsc` builds to
`dist/`). Read `planning/ARCHITECTURE.md` first for the big picture. You are on branch
`feat/m1-slack-gateway`; the repo is otherwise empty.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the test gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding after
only exploring (with zero file changes) is a failure — implement end-to-end in this run.

## Acceptance criteria

1. `npm run check` (= `tsc --noEmit` + `vitest run`) passes from a clean `npm install`.
2. A Bolt Socket Mode app starts from `npm start` given `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
   env vars (loaded via `dotenv`; `.env.example` documents them; `.env` is gitignored).
3. **Session routing**: an `app_mention` event creates (or reuses) a session keyed
   `${channel}:${thread_ts ?? ts}` and enqueues the mention text (bot-mention stripped).
   A plain `message` event that is a thread reply (`thread_ts` set) routes to an existing
   session with that key — and is **ignored** if no session exists (no auto-create from
   un-mentioned replies). Messages from bots (`bot_id` set) and edited/deleted subtypes are
   ignored everywhere.
4. **Serial per thread, concurrent across threads**: each session processes its queue FIFO,
   one message at a time; two different sessions process simultaneously. Proven by a test.
5. **Idle reaping**: a session whose runner has been idle for `IDLE_TIMEOUT_MS`
   (config, default 10 min) has its runner `dispose()`d and is evicted; the next message for
   that thread key transparently creates a fresh runner. Proven by a fake-timer test.
6. **Responder**: for each user message the bot posts a placeholder reply in the thread
   (e.g. "_thinking…_"), then `chat.update`s it with the runner's final text; `status`
   events update the placeholder in place; `error` events update it with a readable error.
7. A `FakeRunner` (the only `RunnerFactory` wired in M1) echoes:
   final text `Echo: ${message}` after emitting one `status` event. `npm start` therefore
   yields a working echo bot end-to-end.
8. README.md: short setup guide incl. a Slack **app manifest** snippet (Socket Mode on;
   bot scopes `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`,
   `im:history`; event subscriptions `app_mention`, `message.channels`, `message.groups`,
   `message.im`).

## Where to look (no precedent repo — these interfaces ARE the contract; copy them verbatim)

```ts
// src/runner/types.ts
export type RunnerEvent =
  | { type: 'status'; text: string }   // progress note (tool use etc.)
  | { type: 'text'; text: string }     // final assistant text for this turn
  | { type: 'error'; message: string };

export interface SessionRunner {
  /** Send one user message; yields events until the turn completes. */
  send(message: string): AsyncIterable<RunnerEvent>;
  dispose(): Promise<void>;
}

export interface RunnerFactory {
  create(sessionKey: string): Promise<SessionRunner>;
}
```

Layout (create exactly):

```
src/index.ts            // entrypoint: env config → Bolt App (socketMode) → registerSlackHandlers
src/config.ts           // typed env loading (fail fast on missing tokens), IDLE_TIMEOUT_MS
src/slack/listener.ts   // registerSlackHandlers(app, deps) + exported pure handler fns
src/slack/responder.ts  // postPlaceholder/update logic over an injected minimal client iface
src/sessions/manager.ts // SessionManager: getOrCreate, enqueue, FIFO drain, idle reaper
src/runner/types.ts
src/runner/fake.ts      // FakeRunner + FakeRunnerFactory (also used by tests)
test/*.test.ts
```

Design rule that makes this testable: **no module imports Bolt except `src/index.ts` and the
thin `registerSlackHandlers`**. Handlers take a `deps` object — `{ sessions: SessionManager,
slack: SlackClientLike, botUserId: string }` where `SlackClientLike` is a minimal interface
(`postMessage`, `update`) you define — so tests drive handlers with plain objects, no Bolt,
no network.

## Test infrastructure (how to test this — do not skip)

Greenfield: you are building the test infra too. Requirements:

- vitest, all tests offline. Assert through **capture fakes**: a `FakeSlackClient` recording
  `postMessage`/`update` calls in arrays, and a `CapturingRunnerFactory` whose runners record
  `send()` calls and yield scripted events (make `FakeRunner` accept a script or a
  per-message async gate so tests can hold a turn open).
- Serial-vs-concurrent proof (criterion 4): use runners whose `send` blocks on a manually
  resolved promise; assert message 2 of the same session does NOT start until message 1's
  gate resolves, while a second session's message completes meanwhile.
- Idle reaping (criterion 5): `vi.useFakeTimers()`; advance past `IDLE_TIMEOUT_MS`; assert
  `dispose()` was called and a subsequent enqueue triggers `factory.create` again. Ensure
  the reaper timer is `unref`'d or clearable so vitest exits cleanly.
- Listener tests: feed synthetic event payloads (mention, thread reply with/without session,
  bot message, `message_changed` subtype) into the exported handler fns; assert session
  creation/routing via the capturing factory and replies via `FakeSlackClient`.
- Minimum: manager FIFO/concurrency/reap tests, listener routing tests, responder
  placeholder→update tests. Aim ~15+ assertions across ≥3 test files.

## Hard constraints (do NOT violate)

- **The test gate must pass** (`npm run check`). Run it yourself before finishing and paste
  the tail of its output.
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `module`/`moduleResolution` `NodeNext`. No `any` (including in tests); no `@ts-ignore`.
- Runtime deps: only `@slack/bolt` and `dotenv`. Dev deps: `typescript`, `vitest`,
  `@types/node`. Nothing else.
- No network calls in tests. No Docker, no `@anthropic-ai/claude-agent-sdk` — that is M2.
- Never log message contents or tokens; log session keys + lifecycle events only.
- `.gitignore`: `node_modules/`, `dist/`, `.env`.
- Do NOT commit — leave the working tree for coordinator review.

## Out of scope (do NOT build)

- DockerRunner, runner container image, NDJSON protocol (M2).
- Agent SDK integration, session resume (M2).
- Streaming-throttle sophistication, rate limits, per-user budgets, slash commands (M3).

## When done — report precisely (with REAL command output)

Before reporting, RUN and paste the ACTUAL output of: `git status --short`, `git diff --stat`
(plus `git ls-files --others --exclude-standard` since files are new), and the full test-gate
tail (with pass/fail counts). **Do not describe any change you cannot point to in those
listings** — the coordinator reconciles your summary against them; a claimed-but-absent change
(especially tests) is a failure. If you could not finish a criterion, SAY SO explicitly.

Then: (1) files created and why; (2) non-obvious design choices; (3) how the tests exercise
criteria 3–7 (and confirm `test/` files appear); (4) anything you could NOT satisfy and why.
