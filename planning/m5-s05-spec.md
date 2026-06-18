# Task: M5 S05 — make the one-shot repo path reachable from Slack (entry trigger + composition-root wiring)

You are implementing one slice in this checkout (a git worktree of `slack-agent`:
TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(the gate, invariants, conventions), then this spec. You are on branch
`sonnet/m5-s05-entry-wiring`. **Do NOT edit this spec file.**

## What this slice delivers

Everything for the one-shot repo agent already exists (broker, `OneShotOrchestrator`,
`DispatchingRunnerFactory`, real `DockerGitNodeExecutor`) — but nothing in production
reaches it: the listener always selects the conversational profile, and the
composition root never wraps the base factory in the dispatcher. This slice closes
that gap with three small wiring changes plus tests:

1. **Listener trigger** — a `task ` keyword prefix on a mention selects the
   `repo-oneshot` profile and passes the rest of the message through to the existing
   one-shot parser.
2. **Config** — new env for the bot tokens and the git image.
3. **Composition roots** (`src/index.ts` and `src/harness/cli.ts`) — build the broker
   + git-node executor and wrap the base factory in `DispatchingRunnerFactory`.

The entry UX (decided with the user): a user starts a one-shot task by mentioning the
bot with a leading `task` verb:

```
@slackbot task github:acme/widgets fix the flaky login test in auth.spec.ts
```

After the bot-mention is stripped, the listener sees `task github:acme/widgets fix …`,
recognizes the `task` keyword, sets the profile to `repo-oneshot`, strips the keyword,
and hands `github:acme/widgets fix …` to the session — which `parseOneShotTask`
already knows how to parse.

## Context — read before writing code (the path, grounded)

The full flow you are completing:

```
listener.handleMention  (sets profileId + message)
  → SessionManager.enqueueNew → getOrCreate → factory.create(sessionKey, profile)
  → DispatchingRunnerFactory.create  (profile.mode==='one-shot' → wraps inner runner)
  → OneShotOrchestrator.send(message) → parseOneShotTask → broker.lease → gitNodes.clone/push/openChangeRequest
  → terminal RunnerEvent {type:'text', text:'Opened PR: <url>'} → posted to the thread
```

Files this builds on (read them):

- `src/slack/listener.ts` — `handleMention` (lines 53–83) builds the session key, strips
  the mention via `stripMention` (line 71), and at **line 79** hardcodes
  `profileId: DEFAULT_PROFILE_ID`. That line is the trigger hook. `handleMessage`
  (thread replies, lines 92–130) is **out of scope** — leave it as-is (see Out of scope).
- `src/profiles/registry.ts` — `Profile` has `mode: 'conversational' | 'one-shot'`.
  `PROFILES` already contains `repo-oneshot` (mode `one-shot`, line 20).
  `DEFAULT_PROFILE_ID = 'conversational'` (line 23). There is **no** exported constant
  for the one-shot id yet — you will add one (see step 1).
- `src/oneshot/dispatching-factory.ts` — `DispatchingRunnerFactory` ctor is
  `(agentFactory: RunnerFactory, broker: CredentialBroker, gitNodes: GitNodeExecutor)`.
  Its `create` dispatches: `profile.mode==='one-shot'` → wraps in `OneShotOrchestrator`;
  else delegates to the base factory. It is itself a `RunnerFactory`, so it drops into
  `buildGateway`'s `factory` dep with no signature change.
- `src/broker/bot-account.ts` — `BotAccountBroker` ctor is
  `(tokens: ReadonlyMap<GitHost, string>)`. `lease()` throws
  `no bot-account token configured for host "<host>"` for an unconfigured host (that
  error already surfaces to the user as an error event — see the orchestrator).
- `src/broker/types.ts` — `GitHost = 'github' | 'gitlab'`.
- `src/oneshot/docker-git-node.ts` — `DockerGitNodeExecutor` ctor is
  `(opts: { image: string; spawn?: SpawnFn; fetchFn?: FetchFn })`. Pass only `image`.
- `src/oneshot/orchestrator.ts` — already complete. On a parse failure it emits
  `{type:'error', message:'Invalid task format. Expected: <host>:<owner>/<repo> <instruction>'}`;
  on success it ends with `{type:'text', text:'Opened PR: <url>'}`. **Do not modify it.**
- `src/config.ts` — `Config` interface (lines 43–51) + `loadConfig` (lines 53–77).
  Helpers `optionalEnvString(name, default)` (line 19) and `requireEnv` already exist.
  The `docker` sub-config (lines 26–41, 67–74) is the pattern to mirror for grouping.
- `src/index.ts` — composition root. Loads config (line 16), selects the base factory
  by `RUNNER_BACKEND` (lines 77–93), then calls `buildGateway({ ..., factory, ... })`
  (lines 95–103). `index.ts` is the only file allowed to import `@slack/bolt`; it may
  import any gateway module (broker, oneshot) — it is the wiring point.
- `src/harness/cli.ts` — the offline/REPL composition root. Selects a base factory by
  `RUNNER_BACKEND` (lines 41–56) using its own local `envString`/`envNumber` helpers
  (it deliberately does **not** call `loadConfig`, to avoid requiring Slack tokens),
  then calls `buildGateway` (lines 62–69).
- `src/app.ts` — `buildGateway`. **No change** — it already takes `factory: RunnerFactory`.

Test infra you will use (read these for the exact recording APIs):

- `test/listener.test.ts` — `makeDeps()` wires a real `SessionManager` over
  `FakeRunnerFactory` + `FakeSlackClient`. The **QueueItem-capture pattern** at lines
  183–227 (wrap `sessions.enqueueNew` to push the `QueueItem` into an array, then assert
  on `item.profileId` / `item.message`) is exactly how you assert the listener's output.
- `test/harness-integration.test.ts` — `makeGateway()` (lines 19–35) builds a real
  gateway over `FakeRunnerFactory` and drives it with `FakeSlackApp.fireMention` +
  `drain()` (20 ms). This is the template for the end-to-end one-shot test, except you
  pass a `DispatchingRunnerFactory` as the `factory`.
- `src/broker/fake.ts` — `FakeBroker(token='fake-token')`; records `leases: LeaseRequest[]`
  and `revokes`.
- `src/oneshot/fake-git-node.ts` — `FakeGitNodeExecutor(prUrl?)`. **Read it** for the
  exact field names it records (clone/push/openChangeRequest calls) and the PR-url it
  returns from `openChangeRequest` — assert against those, do not guess.
- `src/runner/fake.ts` — `FakeRunnerFactory` (echoes `Echo: <msg>` as a `text` event);
  records `creates: string[]` and `runners`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this
run.

## Implementation

### Step 1 — `src/profiles/registry.ts`: export the one-shot id constant
Add, next to `DEFAULT_PROFILE_ID` (line 23):
```ts
export const REPO_ONESHOT_PROFILE_ID = 'repo-oneshot';
```
Use this constant everywhere instead of the magic string `'repo-oneshot'`.

### Step 2 — `src/slack/listener.ts`: the `task` keyword trigger
- Add a small **pure, exported** helper near `stripMention` (line 12), e.g.:
  ```ts
  /**
   * Recognize the one-shot trigger: a leading `task` keyword (case-insensitive)
   * followed by the one-shot task text. Returns the task text with the keyword
   * removed, or null if the message is not a one-shot trigger.
   */
  export function parseOneShotTrigger(stripped: string): string | null { … }
  ```
  Match `^task\s+(.+)$` with the `i` (case-insensitive) and `s` (dotall, so multi-line
  instructions survive) flags, against the already-`trim()`med input; return the trimmed
  capture group, or `null` if no match. A bare `task` with no following text does **not**
  match (`\s+(.+)` requires a non-empty remainder) → falls through to conversational.
  Do **not** validate the `host:repo` shape here — that is the orchestrator's job
  (`parseOneShotTask` already emits a helpful error event on a malformed remainder).
  Keep this helper free of any `src/oneshot/` import (the listener stays decoupled).
- In `handleMention`, after computing `const message = stripMention(...)` (line 71),
  branch:
  ```ts
  const oneShot = parseOneShotTrigger(message);
  const profileId = oneShot !== null ? REPO_ONESHOT_PROFILE_ID : DEFAULT_PROFILE_ID;
  const outMessage = oneShot ?? message;
  ```
  Pass `outMessage` as `message` and `profileId` in the `enqueueNew` call (lines 75–82).
  Import `REPO_ONESHOT_PROFILE_ID` alongside the existing `DEFAULT_PROFILE_ID` import.

### Step 3 — `src/config.ts`: bot tokens + git image
Add a one-shot sub-config mirroring the `docker` grouping. Add to `Config`:
```ts
oneshot: {
  /** Docker image used for the ephemeral credentialed git nodes (clone/push). */
  GIT_IMAGE: string;
  /** Per-host bot-account tokens. Absent host → that host is unavailable (lease throws). */
  githubToken: string | undefined;
  gitlabToken: string | undefined;
};
```
In `loadConfig`, populate it:
- `GIT_IMAGE`: `optionalEnvString('GIT_IMAGE', 'slackbot-runner:latest')`.
- `githubToken` / `gitlabToken`: read `GITHUB_BOT_TOKEN` / `GITLAB_BOT_TOKEN`; map an
  empty/unset value to `undefined`. Add a tiny helper
  `optionalEnvMaybe(name): string | undefined` (returns `undefined` when unset/empty) —
  do **not** reuse `optionalEnvString` (which forces a default). `exactOptionalPropertyTypes`
  is on: typing the fields as `string | undefined` (not `?:`) lets you assign `undefined`
  directly without conditional spread.

### Step 4 — `src/index.ts`: wrap the base factory (real path)
After the base-factory selection block (currently ending line 93, var `factory`),
build the dispatcher and pass it to `buildGateway`:
```ts
import { BotAccountBroker } from './broker/bot-account.js';
import type { GitHost } from './broker/types.js';
import { DockerGitNodeExecutor } from './oneshot/docker-git-node.js';
import { DispatchingRunnerFactory } from './oneshot/dispatching-factory.js';
// …
const oc = config.oneshot;
const botTokens = new Map<GitHost, string>();
if (oc.githubToken !== undefined) botTokens.set('github', oc.githubToken);
if (oc.gitlabToken !== undefined) botTokens.set('gitlab', oc.gitlabToken);
const broker = new BotAccountBroker(botTokens);
const gitNodes = new DockerGitNodeExecutor({ image: oc.GIT_IMAGE });
const dispatchingFactory = new DispatchingRunnerFactory(factory, broker, gitNodes);
console.log(
  `[gateway] one-shot enabled (git image=${oc.GIT_IMAGE}, hosts=[${[...botTokens.keys()].join(',')}])`,
);
```
Pass `factory: dispatchingFactory` to `buildGateway` (line 99). **Never log token
values** — only host names / image, as above.

The dispatcher always wraps the base factory; this is harmless for conversational
sessions (it delegates straight through). A one-shot trigger only does real work when
a token for that host is configured and Docker is available — otherwise the orchestrator
surfaces the failure as an error event in the thread.

### Step 5 — `src/harness/cli.ts`: wrap for the REPL too
So `task …` typed in the harness REPL exercises the one-shot path (fake offline,
real for live smoke). After the base-factory block (lines 41–56), choose broker +
git-node executor by backend, then wrap:
- **docker backend** (live): `BotAccountBroker` from `GITHUB_BOT_TOKEN` / `GITLAB_BOT_TOKEN`
  env (build the `Map<GitHost,string>` the same way as index.ts, omitting unset hosts) +
  `new DockerGitNodeExecutor({ image: envString('GIT_IMAGE', 'slackbot-runner:latest') })`.
- **fake backend** (offline REPL): `new FakeBroker()` + `new FakeGitNodeExecutor()` so a
  typed `task github:acme/widgets do X` runs end to end without Docker, posting a fake
  PR link.
Wrap with `new DispatchingRunnerFactory(factory, broker, gitNodes)` and pass that to
`buildGateway`. Log which one-shot mode (fake vs docker) is active, no token values.

## Acceptance criteria

1. `npm run gate` passes — all 162 existing tests still pass, plus the new ones, and
   `npm run boundaries` stays clean. Paste the tail of the output.
2. **Listener trigger** (new tests in `test/listener.test.ts`, QueueItem-capture pattern):
   - `@bot task github:acme/widgets fix the bug` → captured `QueueItem.profileId ===
     'repo-oneshot'` **and** `QueueItem.message === 'github:acme/widgets fix the bug'`
     (keyword stripped, `host:repo` remainder intact).
   - Case-insensitive: `Task …` / `TASK …` also trigger.
   - A normal mention (`hello there`) → `profileId === 'conversational'`, message intact.
   - A bare `task` (no remainder) → `profileId === 'conversational'`, message `'task'`.
   - Direct unit tests of `parseOneShotTrigger` for the same cases are welcome and cheap.
3. **End-to-end one-shot** (new integration test, e.g. `test/oneshot-entry.test.ts`,
   modeled on `test/harness-integration.test.ts`): build a gateway whose `factory` is
   `new DispatchingRunnerFactory(new FakeRunnerFactory(), new FakeBroker(), new
   FakeGitNodeExecutor('<some pr url>'))`, fire
   `<@UHARNESS> task github:acme/widgets do the thing` via `fakeApp.fireMention`, drain,
   and assert:
   - the **last** Slack update text is the orchestrator's terminal PR line containing the
     fake PR url (`Opened PR: <url>`);
   - `FakeBroker.leases` recorded exactly one lease with `host==='github'`,
     `repo==='acme/widgets'`;
   - `FakeGitNodeExecutor` recorded a clone, a push, and an openChangeRequest (assert on
     its actual recording fields — read the fake first).
   - Add a contrast case: a conversational mention (`<@UHARNESS> hello`) through the
     **same** dispatching gateway still produces `Echo: hello` and records **no** lease.
4. No production code logs any token value (grep your diff).

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the real tail when done. The suite is
  offline — no Slack, no Docker, no API, no network. Keep it that way (the new tests use
  the fakes only).
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`**; `NodeNext` ESM (`.js`
  import specifiers); `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  are on. Inject dependencies; never reach for the real world in tests.
- **Boundary invariants** (enforced by `npm run boundaries`): `@slack/bolt` only in
  `src/index.ts`; the gateway never imports the `runner/` package or the Agent SDK; no
  circular deps. Your new imports (broker, oneshot) into `index.ts`/`cli.ts` are gateway
  modules and are allowed.
- **Never log message contents or tokens** — session keys, lifecycle, host names, image
  names, filenames/sizes only.
- Do not modify `src/oneshot/orchestrator.ts`, `src/oneshot/dispatching-factory.ts`,
  `src/app.ts`, or `protocol.ts`. Add no dependencies.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- **Thread-reply (`handleMessage`) trigger handling.** One-shot mode does not resume —
  the PR is the artifact. A `task …` reply inside an existing thread is not a supported
  entry; leave `handleMessage` unchanged. (Future milestone if ever wanted.)
- **The S04 blueprint** (research→plan→implement, lint/test nodes, failure classifier).
  This slice only makes the existing minimal blueprint reachable.
- **Channel→profile bindings / profile-selection UX** beyond the `task` keyword
  (deferred in `0003`).
- **Approval gates / egress-lock** (M6).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The real tail of `npm run gate` (test count must be > 162; name the new total).
- Confirm `git diff --stat` shows the new `test/` file(s) and the edited sources.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (e.g. `cli.ts` is not
  unit-tested — note that the integration test covers the equivalent composition).
