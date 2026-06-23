# Task: record per-turn phase durations (spawnMs / agentMs / publishMs) into the audit ledger

You are implementing one slice in this repository checkout
(`/Users/jedanner/workspace/sa-wt-codex-m7-timing-metrics`, a git worktree of
slack-agent — TypeScript, Node 20+, ESM, vitest, strict tsc). All paths below are
repo-relative and resolve here. **Read the root `CLAUDE.md` first** (gate,
invariants, conventions); you touch the runner-facing `src/runner/docker.ts` but
not the container `runner/` package. You are on branch `codex/m7-timing-metrics`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

## Context — read before writing code

This is `track` item **`361d52`** (telemetry: turn latency + container spawn/ready
duration metrics). It records, per turn, how long each phase took, into the audit
ledger as counts/durations only (never message content).

**Precedent to mirror — PR #69 (the commit right before yours on this branch's
base, `git show d9def32 --stat`).** It added a new `kind:'decision'` audit stream +
a new nullable `pull_requests.correlation_id` column with a durable ALTER-only
migration. Your store/schema/kind/audit-column work is the **same shape** — find
how #69 plumbed `correlation_id` and `kind:'decision'` end to end (store.ts
schema + migration + prepared insert + `recordAudit` + `AuditEvent` interface;
manager `audit()` call) and mirror it for a `durations_ms` column + `kind:'timing'`.

The three phases and their measurement seams (grounded — use these):
- **`agentMs`** — the per-turn drive duration. Measured entirely in `manager.ts`
  with the existing injectable `this.now()` (constructor `opts.now`, default
  `Date.now()`; see the spend-cap 24h-window code for the pattern). Bracket the
  `driveToThread(...)` call inside `drain()` (the call at ~`manager.ts:1178`).
- **`spawnMs`** — container spawn→ready latency. `factory.create()` awaits the
  ready handshake (`docker.ts` `DockerRunnerFactory.create` awaits
  `DockerRunner.waitReady` at ~`:1040`), so bracket the **`this.factory.create(...)`
  calls in `manager.ts`** (the two sites: `enqueueNew` ~`:243` and `ensureRunner`
  ~`:292`) with `this.now()`. No docker.ts change needed for spawn. Stash the
  measured value on the session (see `pendingSpawnMs` below) and attribute it to
  the next turn's timing row (cold-start / rehydrate turns only).
- **`publishMs`** — PR open/edit/comment service time. This is measured INSIDE the
  `docker.ts` `send()` generator around `publishService.publish/editPr/commentPr`
  (the three sites ~`:619-649`, `:680-701`, `:729-750`). Attach the elapsed to the
  gateway-internal `pr_opened`/`pr_edited`/`pr_commented` events (a new optional
  `elapsedMs` field); the manager accumulates them across the turn.

Other code this builds on:
- `src/runner/types.ts` — the gateway-internal `RunnerEvent` union; `pr_opened`
  (`:21`), `pr_edited` (`:23`), `pr_commented` (`:25`). These are **gateway-internal,
  NOT wire/protocol** — they never cross the container boundary, so **no
  `protocol.ts` change in this slice.**
- `src/sessions/store.ts` — `AuditEvent` (`:57`), `kind` union (`:62`), the
  `audit_events` schema + `auditColumns()`/ALTER migration pattern (`:401`, `:360`,
  `:419`), the prepared insert (`:267`) + `recordAudit` (`:489`), `stmtGetAudit`
  select list (`:283`).
- `src/sessions/manager.ts` — `audit()` helper (`:1279`); the `Session` type;
  `driveToThread()` (`:709`) with its `pr_opened`/`pr_edited`/`pr_commented`
  handlers; `drain()` (`:1128`); the per-turn `kind:'cost'` row (`:872`) as the
  template for "one metadata row per turn".
- `src/runner/docker.ts` — `DockerRunner` + `DockerRunnerConfig` + the `send()`
  generator publish-servicing sites. Currently uses `Date.now()` directly (no clock
  seam); add an injectable clock for testable publish timing (below).

## The design (decided — do not re-derive)

1. **Sink: a new `kind:'timing'` audit row, one per turn, written in `drain()`.**
   Add `'timing'` to the `AuditEvent['kind']` union. Add a new nullable
   **`durations_ms TEXT`** column to `audit_events` (durable ALTER migration,
   mirroring #69's `correlation_id`; read columns before CREATE, `ALTER ... ADD
   COLUMN` only if absent, never drop). It holds a small JSON object,
   `{"agentMs":1234,"spawnMs":800,"publishMs":300}` — `agentMs` always present;
   `spawnMs`/`publishMs` present only when that phase occurred this turn.
   Counts/durations only — no message content. Extend `AuditEvent`, the prepared
   insert (now 13 columns), `recordAudit`, `stmtGetAudit`, and the `audit()` helper
   to accept `durations_ms?: string | null`.

2. **`Session` accumulators.** Add to the `Session` type:
   `pendingSpawnMs: number | null` (set at the `factory.create` sites; consumed +
   cleared when a timing row is written) and a per-turn `turnPublishMs: number`
   (reset to 0 at turn start in `drain`, incremented in `driveToThread`'s `pr_*`
   handlers by `event.elapsedMs ?? 0`).

3. **`drain()` writes the timing row.** Bracket the `driveToThread(...)` call:
   `const t0 = this.now(); ... await this.driveToThread(...); const agentMs =
   this.now() - t0;`. Immediately after, write ONE `kind:'timing'` row with
   `durations_ms = JSON.stringify({ agentMs, ...(session.pendingSpawnMs != null ?
   { spawnMs: session.pendingSpawnMs } : {}), ...(session.turnPublishMs > 0 ?
   { publishMs: session.turnPublishMs } : {}) })`, then clear `pendingSpawnMs` to
   null and `turnPublishMs` to 0. Only write when `driveToThread` actually ran (a
   turn that was rejected pre-drive — e.g. spend-cap — gets no timing row).
   `tool: null`, `result: null`; carry `team_id`/`user_id`/`profile_id` like the
   cost row. **Do NOT** write a timing row inside `driveToThread` itself — that
   method is also called for build/exec sub-runs (`:982`, `:1097`); per-turn timing
   belongs at the `drain` boundary so each user turn gets exactly one row (publishes
   during a nested build still count, since `turnPublishMs` accumulates across the
   whole turn).

4. **`publishMs` in docker.ts.** Add an injectable clock to `DockerRunner` — an
   optional `now?: () => number` on `DockerRunnerConfig` (default `Date.now()`),
   read once into a field. Around each of the three publish-service calls in
   `send()`, measure `const ms = this.now() - start` and attach `elapsedMs: ms` to
   the yielded `pr_opened`/`pr_edited`/`pr_commented` event. Add the optional
   `elapsedMs?: number` field to those three variants in `types.ts`.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus new ones). No
   `protocol.ts` change (the `pr_*` events are gateway-internal); `diff
   src/runner/protocol.ts runner/src/protocol.ts` still prints nothing.
2. Each top-level turn that drives the runner writes exactly one `kind:'timing'`
   audit row whose `durations_ms` JSON contains an integer `agentMs`.
3. A cold-start / rehydrate turn's timing row additionally carries `spawnMs` (the
   bracketed `factory.create` duration); a subsequent warm turn's row omits it.
4. A turn that opens/edits/comments a PR carries `publishMs` = the summed
   `elapsedMs` of its `pr_*` events; a turn with no publish omits `publishMs`.
5. `docker.ts` attaches `elapsedMs` (from the injectable clock) to
   `pr_opened`/`pr_edited`/`pr_commented`.
6. New tests (using the existing fakes — `CapturingStore`, scripted `FakeRunner`s
   like the `DecisionRunner` pattern in `test/manager.test.ts`, an injected
   advancing `now()` per the spend-cap window tests, and the `DockerRunner` fake in
   `test/docker-publish.test.ts`): a timing row with `agentMs`; `spawnMs` present on
   cold start and absent on the warm follow-up turn; `publishMs` summed from `pr_*`
   `elapsedMs`; a `kind:'timing'` + `durations_ms` store round-trip; and migration
   of a legacy `audit_events` table lacking `durations_ms` (mirror #69's
   `correlation_id` migration test).

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers).
  `exactOptionalPropertyTypes` is on — `durations_ms`/`elapsedMs`/`pendingSpawnMs`
  are genuinely optional/nullable, never `undefined`-valued in object literals (use
  the conditional-spread idiom #69 used).
- **Never log message contents or tokens** — durations are counts only; do not add
  content to logs. A timing audit row carries only the durations JSON + the usual
  session/team/user/profile metadata.
- Keep the audit write **best-effort** (the existing `audit()` already swallows +
  logs store errors) — a metadata-write hiccup must never flip a successful turn
  into an error.
- This slice makes **no `protocol.ts` change** and does not touch the container
  `runner/` package. Measure spawn/agent in `manager.ts`, publish in `docker.ts`.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- Any read/query/export path or dashboard for the durations (capture only).
- Latency for build/exec **sub-runs** as their own rows (publishes within them are
  counted into the turn, but no separate timing row).
- Reworking docker.ts's other `Date.now()` deadline math to the new clock — only the
  three publish-service measurements use the injected `now`.
- Per-tool / per-profile cost split (`a1f221`), malformed-line surfacing (`d185bd`),
  and the other open telemetry items.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased), and confirmation the
  two `protocol.ts` copies still diff clean.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way.
