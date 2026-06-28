# Task: Convert the per-turn timeout to an inactivity timer + absolute backstop, with a thinking heartbeat so long model turns aren't killed

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is
a worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `runner/CLAUDE.md` first** (gate, invariants, the protocol-copy
rule), then the context below. You are on branch `sonnet/turn-heartbeat-timeout`.

## Why (context — read before writing code)

A live review turn died with `turn timed out after 300000ms` while the agent was
actively working (writing/running repro scripts, reading a cloned repo). The
current per-turn timeout in `src/runner/docker.ts` is **not** an inactivity timer —
it's a **wall-clock cap**: `deadline` is set once at turn start (`docker.ts:426`)
and reset **only** when the gateway does delegated work (the `request_*` branches:
clone/build/exec/publish/pr_edit/pr_comment/run_checks/read_issue/provision — lines
545,576,624,676,712,742,774,799,832). `status`/`text`/`file`/`usage`/`decision` do
**not** reset it. So a turn that uses only SDK-internal tools (Bash/Read/Grep) has a
fixed `turnStart + RUNNER_TURN_TIMEOUT_MS` budget and dies once it exceeds it, even
while productively working. There is **no other absolute turn cap anywhere** — this
deadline is the only bound.

Separately, during pure model *thinking*, the runner emits **nothing** over the
protocol, so even a true inactivity timer couldn't distinguish "thinking hard" from
"hung." The Agent SDK *can* surface mid-generation liveness via
`includePartialMessages` (see below), but the runner doesn't enable it.

**Decided design (do not re-litigate):**
1. Make the per-turn timeout a true **inactivity timer** (reset on any real agent
   progress) **plus a separate, larger absolute per-turn ceiling** so a runaway
   agent loop still gets killed.
2. Drive a **thinking heartbeat** off **SDK partial messages**: set
   `includePartialMessages: true`, throttle the resulting `stream_event` into a
   content-free `heartbeat` protocol message that resets the inactivity deadline and
   is **never forwarded to Slack**.

### Grounded facts (verified at `bd4bc10`; `design/` is gitignored — all inlined here)

- **Gateway read loop**: `src/runner/docker.ts:424-460+`. `let deadline = Date.now()
  + turnTimeoutMs` (426); loop computes `remaining = deadline - Date.now()` (429),
  times out on `remaining <= 0` (430) or when `nextLineWithTimeout(remaining)`
  returns `'timeout'` (437). Liveness branches that currently do NOT reset: `status`
  (459), `file` (461/473), `usage` (474), `decision` (483), `text` (500, then
  `break`). The nine `request_*` branches DO reset via `deadline = Date.now() +
  turnTimeoutMs`.
- **Clock seam (USE IT)**: `DockerRunnerConfig.now?: () => number` exists
  (`docker.ts:59`) and `this.now = config.now ?? (() => Date.now())` (168) — but the
  deadline math at 426/429 calls raw `Date.now()`, bypassing it. Route ALL deadline
  math through `self.now()` so the new timers are deterministically testable.
- **Config**: `RUNNER_TURN_TIMEOUT_MS` interface field `src/config.ts:52`, parsed
  `src/config.ts:415` (`optionalEnvNumber('RUNNER_TURN_TIMEOUT_MS', 5 * 60_000)`),
  wired `src/index.ts:130` (`turnTimeoutMs: dc.RUNNER_TURN_TIMEOUT_MS`), and also
  read in `src/harness/cli.ts:95` (`envNumber('RUNNER_TURN_TIMEOUT_MS', 5*60_000)`).
- **Runner query options block**: `runner/src/main.ts:~896-910` (the `options: {
  resume?, cwd, permissionMode, allowDangerouslySkipPermissions, disallowedTools,
  systemPrompt }` object passed to `deps.sdkQuery`). `includePartialMessages` goes
  here. Confirmed in `runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
  1592-1596`: `includePartialMessages?: boolean` — "When true,
  `SDKPartialAssistantMessage` events will be emitted during streaming."
- **The SDK partial event** (`sdk.d.ts:3733-3740`): `SDKPartialAssistantMessage = {
  type: 'stream_event'; event: BetaRawMessageStreamEvent; parent_tool_use_id: string
  | null; uuid; session_id; ttft_ms? }`. It fires very frequently (token-level) — the
  runner MUST throttle it, not forward one heartbeat per event.
- **Runner event loop**: `runner/src/main.ts:~919-1023` — `for await (const event of
  stream)`, branches on `system`(init)/`tool_progress`/`tool_use_summary`/`assistant`
  /`result`; everything else falls through (ignored). `emit(...)` writes a
  `RunnerToGatewayMessage` as NDJSON. `tool_progress`/`tool_use_summary`/tool_use
  blocks already emit protocol `status` messages.
- **Runner has no clock seam** — `turnStartMs = Date.now()` (`main.ts:~882`) is a raw
  call. The throttle needs an injectable `now`; `deps` is the injection seam (all
  external fns are passed in). Add `now?: () => number` to the runner deps and use it.
- **Protocol**: `RunnerToGatewayMessage` union + `StatusMessage = { type: 'status';
  id: string; text: string }` live in `runner/src/protocol.ts` AND the byte-identical
  `src/runner/protocol.ts`. **Both copies must change in lockstep.**
- **Status IS forwarded to Slack**: `src/sessions/manager.ts:739-744` posts every
  `status` event to the thread as italic text. So a heartbeat must NOT reuse
  `status` — it needs its own message type that the gateway consumes silently.
- **FakeAgentSdk**: `runner/test/runner-main.test.ts:~18-50` — constructed with
  `TurnResult[]` (each `TurnResult = SDKMessage[]`); its query fn yields the array in
  order. `make…` builders (e.g. `makeSdkToolProgress`, `~149-159`) construct events.
  The captured query params are inspectable (assert `includePartialMessages: true`).

## CRITICAL — do not stop after exploration

Implement every edit, add tests, run `npm run gate`, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure.

## CRITICAL — ground SDK usage, don't recall it

Before writing any SDK call/field, confirm it in
`runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Use only symbols you
can point to (`includePartialMessages`, the `'stream_event'` type). If the real
shape differs from this spec, follow the real API and note it in your report.

## Implementation — exact mechanics

### 1. Protocol — new `heartbeat` message (BOTH copies, byte-identical)

Add to `runner/src/protocol.ts` and `src/runner/protocol.ts`:
```ts
export type HeartbeatMessage = {
  type: 'heartbeat';
  id: string;
};
```
Add `HeartbeatMessage` to the `RunnerToGatewayMessage` union in both files. It
carries no content (privacy invariant — it's a pure liveness ping).

### 2. Runner — enable partial streaming + emit a throttled heartbeat

- In the query `options` object (`main.ts:~898`), add `includePartialMessages: true`.
- Add an injectable clock to the runner deps: `now?: () => number` (default
  `Date.now`); resolve once as a local `const now = deps.now ?? (() => Date.now())`.
  Replace the `turnStartMs = Date.now()` read with `now()` too (so the seam is
  consistent), but that's incidental.
- Add a module constant `const HEARTBEAT_THROTTLE_MS = 10_000;` (emit at most one
  heartbeat per 10s of streaming — far below the 5-min inactivity window so active
  thinking never trips it).
- In the event loop, add a branch for the partial event BEFORE the
  ignored-fall-through. The SDK partial event has `type: 'stream_event'`. On it:
  ```
  if (event.type === 'stream_event') {
    if (now() - lastHeartbeatMs >= HEARTBEAT_THROTTLE_MS) {
      lastHeartbeatMs = now();
      emit({ type: 'heartbeat', id });
    }
    continue;
  }
  ```
  Initialize `let lastHeartbeatMs = 0;` per turn (so the first stream_event always
  emits a heartbeat). Do NOT forward the partial content anywhere — it is liveness
  only; the final assistant text still ships via the existing `text` path unchanged.

### 3. Gateway — inactivity deadline + absolute backstop + silent heartbeat

In `src/runner/docker.ts`, rework the per-turn loop (424-440 + the reset sites):

- New config field `absoluteTurnTimeoutMs: number` on `DockerRunnerConfig`.
- At turn start:
  ```
  const { turnTimeoutMs, absoluteTurnTimeoutMs } = self.config;
  const turnStart = self.now();
  let idleDeadline = turnStart + turnTimeoutMs;          // reset on liveness
  const absoluteDeadline = turnStart + absoluteTurnTimeoutMs; // never reset this turn
  ```
- Loop head:
  ```
  const now = self.now();
  const effectiveDeadline = Math.min(idleDeadline, absoluteDeadline);
  const remaining = effectiveDeadline - now;
  if (remaining <= 0) { yield self.errorEvent(timeoutReason(now), 'timeout'); break; }
  const rawLine = await self.nextLineWithTimeout(remaining);
  if (rawLine === 'timeout') { yield self.errorEvent(timeoutReason(self.now()), 'timeout'); break; }
  ```
  where `timeoutReason(t)` returns
  `t >= absoluteDeadline ? \`turn exceeded absolute limit of ${absoluteTurnTimeoutMs}ms\` : \`turn timed out after ${turnTimeoutMs}ms\``.
  Keep the existing `'timeout'` errorClass for both (the idle message text stays
  byte-identical to today's `turn timed out after ${turnTimeoutMs}ms` so nothing that
  matches on it breaks).
- **Reset `idleDeadline = self.now() + turnTimeoutMs` on every liveness message**:
  the `status` (459), `file` (after successful decode, 473), `usage` (474), and
  `decision` (499) branches. Rename the nine existing `request_*` resets from
  `deadline = Date.now() + turnTimeoutMs` to `idleDeadline = self.now() +
  turnTimeoutMs`. Do NOT reset `absoluteDeadline` anywhere within the turn.
- **New `heartbeat` branch** (place near the `status` branch, with `parsed.id ===
  id`): reset `idleDeadline = self.now() + turnTimeoutMs` and `continue` —
  **do NOT `yield`** anything. This is what keeps it invisible to Slack.
- Replace the remaining raw `Date.now()` calls in this loop with `self.now()` so the
  timers are testable via the clock seam. (Leave `Date.now()` used for the turn `id`
  at 407 alone — that's identity, not timing.)

### 4. Config wiring — `RUNNER_TURN_ABSOLUTE_TIMEOUT_MS` (default 30 min)

- `src/config.ts`: add `RUNNER_TURN_ABSOLUTE_TIMEOUT_MS: number` to the config
  interface (next to `RUNNER_TURN_TIMEOUT_MS:52`) and parse it:
  `optionalEnvNumber('RUNNER_TURN_ABSOLUTE_TIMEOUT_MS', 30 * 60_000)`.
- `src/index.ts:~130`: pass `absoluteTurnTimeoutMs: dc.RUNNER_TURN_ABSOLUTE_TIMEOUT_MS`
  alongside `turnTimeoutMs`.
- `src/harness/cli.ts:~95`: add
  `absoluteTurnTimeoutMs: envNumber('RUNNER_TURN_ABSOLUTE_TIMEOUT_MS', 30 * 60_000)`.

## Acceptance criteria (each maps to a test or observable behavior)

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. All existing tests pass plus new ones.
2. `protocol.ts` has `HeartbeatMessage` in BOTH copies, byte-identical, in the
   `RunnerToGatewayMessage` union.
3. **Runner**: query options include `includePartialMessages: true` (assert via the
   FakeAgentSdk-captured params). A turn that yields several `stream_event` messages
   emits **throttled** `heartbeat` protocol messages — first stream_event → one
   heartbeat; rapid follow-ups within `HEARTBEAT_THROTTLE_MS` → no extra; a
   stream_event after the throttle window (advance the injected `now`) → another.
   No partial content is forwarded as `text`/`status`.
4. **Gateway inactivity reset**: a `heartbeat` (and a `status`) received before the
   idle window elapses resets `idleDeadline`, so a turn that keeps emitting
   heartbeats past `turnTimeoutMs` does **not** time out. The heartbeat is consumed
   silently — assert it does NOT surface as a `status`/any forwarded RunnerEvent
   (so `manager.ts` never posts it to Slack).
5. **Gateway absolute backstop**: a turn that emits heartbeats forever still times
   out once `absoluteTurnTimeoutMs` is exceeded, with the absolute-limit message and
   `'timeout'` errorClass. Drive via the `self.now()` clock seam (and small
   configured timeouts) — deterministic, no real sleeps.
6. **Idle timeout unchanged in spirit**: a turn that emits NOTHING for
   `turnTimeoutMs` still times out with the existing `turn timed out after
   ${turnTimeoutMs}ms` message + `'timeout'` class.
7. Config: `RUNNER_TURN_ABSOLUTE_TIMEOUT_MS` parses (default 30*60_000) and is wired
   into `DockerRunnerConfig` via `index.ts` and `harness/cli.ts`.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- `protocol.ts` is two byte-identical copies — edit BOTH.
- **The heartbeat carries no content and is never forwarded to Slack** (privacy +
  no-spam). Never log message contents or tokens.
- No `any`, no `@ts-ignore`; NodeNext ESM (`.js` specifiers); inject external deps
  (the new clock seams are exactly this). Suite stays offline (no Docker/Slack/API/
  network) — use FakeAgentSdk / FakeChildProcess and the `now` seams; **no real
  `setTimeout`-based sleeps in tests** for the deadline logic.
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Subprocess / timing correctness (call these out in your report)

- The deadline math MUST go through `self.now()` (the clock seam), not `Date.now()`,
  or the absolute/idle tests can't be deterministic. `nextLineWithTimeout` still uses
  a real timer for the wait itself — drive timeout tests by making `remaining <= 0`
  via the clock seam and/or feeding lines through the fake child, mirroring the
  existing docker timeout tests (see `test/docker*.test.ts`). Confirm how the
  existing turn-timeout test drives time and follow that pattern.
- Throttle correctness: `lastHeartbeatMs` starts at 0 and is per-turn; the first
  stream_event always emits; subsequent ones gate on `now() - lastHeartbeatMs`.

## Out of scope (do NOT build)

- Charging delegated (gateway-side) work against the absolute ceiling differently /
  excluding it — the absolute deadline is a simple `turnStart + absolute`, never
  reset within the turn. A turn with very long delegated builds could in theory hit
  it; the 30-min default + env override covers it. Note it as a known limitation; do
  not build subtraction logic.
- Forwarding partial assistant text to Slack (streaming the reply live) — heartbeat
  is liveness only.
- Driving the heartbeat off `thinking_tokens` — we chose `includePartialMessages`.
- Subagent-survey prompt nudge (separate issue 22c224) and the file-forward
  clone-dump (d2b098).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real) — test count + file count.
- How you drove the timeout tests deterministically (which seam) + confirmation the
  heartbeat is consumed silently (not forwarded).
- Any deviation from this spec and why; anything a unit test can't catch.
