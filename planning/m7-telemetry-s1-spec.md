# Task: Make terminal turn-errors reconstructable — log + audit them with a typed reason

You are implementing one slice in
`/Users/jedanner/workspace/sa-wt-codex-telemetry-terminal-errors` (an isolated
worktree; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` first** (gate, invariants, conventions), then the context below. You
are on branch `codex/telemetry-terminal-errors`.

## Context — read before writing code

- **Motivating need:** today, when a turn ends in a terminal error (container died,
  SDK error, turn timed out), the runner yields a gateway-internal `error` event.
  The manager posts `:x: Error: <message>` to Slack and *captures* it — but on the
  main conversational path the outcome is **discarded** (`manager.ts:1126` ignores
  `driveToThread`'s return). There is **no gateway log line and no audit row** for
  that failure. In beta, "the bot gave me a red X" is then unreconstructable from
  logs/audit alone, and an OOM is indistinguishable from a 529 or a timeout. A live
  smoke last session hit exactly this wall ("can't determine what happened").

- **Code this builds on:**
  - `src/sessions/manager.ts` — `driveToThread` handles the runner event stream;
    the `error` branch is at **`:875–877`** (`tryUpdate(...)` + `captured = {...}`).
    The `audit()` helper is at **`:~1231`** (truncates summary, fills nulls, calls
    `store.recordAudit`, swallows-and-logs on failure). The `usage`/`cost` branch
    at `:857` is the model to copy for a metadata-only audit.
  - `src/runner/types.ts` — `RunnerEvent` union. The `error` variant is **`:29`**
    (`{ type: 'error'; message: string }`). **This is gateway-internal — it never
    crosses the container boundary**, so changing it is NOT a protocol/wire change.
  - `src/runner/docker.ts` — yields the `error` events: turn timeout at **`:357`**
    and **`:367`**, unexpected process exit at **`:375`**, relayed container error
    at **`:821`**, and "stdin not writable" send failures (`:336, :469, …`). The
    child's exit handler `onExit` at **`:192`** currently ignores `code`/`signal`.
  - `src/sessions/store.ts` — `AuditEvent.kind` union at **`:61`**; the
    `audit_events` DDL at **`:~409`** declares `kind TEXT NOT NULL` with **no CHECK
    constraint**, so a new kind value needs **no migration** — only the TS union.
  - `test/manager.test.ts` — the fake store exposes `audits: AuditEvent[]`
    (`recordAudit` pushes; see `:111`). Tests assert via
    `store.audits.filter(a => a.kind === '…')` (e.g. `:746`, `:1740`). `FakeRunner`
    drives event streams. `test/docker.test.ts` exercises `DockerRunner` with a
    fake child process.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

## Acceptance criteria

1. `npm run check` passes (all existing tests keep passing, plus new ones), and
   `npm run boundaries` stays clean.

2. **Typed error reason (gateway-internal only).** The `RunnerEvent` `error`
   variant in `src/runner/types.ts:29` gains a required discriminant:
   `{ type: 'error'; message: string; reason: ErrorReason }` where
   `type ErrorReason = 'timeout' | 'container_exit' | 'runner_error'`. Update every
   `yield { type: 'error', … }` site in `src/runner/docker.ts` to set `reason`:
   - turn-timeout yields (`:357`, `:367`) → `'timeout'`
   - unexpected process-exit yield (`:375`) → `'container_exit'`
   - relayed container error (`:821`, i.e. an error the runner reported, e.g. an SDK
     failure) → `'runner_error'`
   - "runner is disposed" / "stdin is not writable" / any remaining send-side
     failure yields → `'runner_error'`
   This is **not** a `protocol.ts` change — do not touch either `protocol.ts` copy;
   the wire `ErrorMessage` type stays as-is.

3. **Container exit detail is captured.** `onExit` in `src/runner/docker.ts:192`
   records the exit `code` and `signal` on the instance; the unexpected-exit error
   message at `:375` includes them, e.g.
   `runner process exited unexpectedly (code=137, signal=null)`. Also emit one
   gateway log line at that point: `console.error('[runner] container exited
   unexpectedly for <id-or-session>: code=<code> signal=<signal>')`. (These are
   system-generated values, not message content — safe to log.)

4. **Terminal errors are logged AND audited, once, at the funnel.** In
   `driveToThread`'s `error` branch (`src/sessions/manager.ts:875`), in addition to
   the existing Slack post and `captured` assignment:
   - emit a gateway log line: `console.error('[session] turn error
     (<reason>) <session.key>: <message>')`
   - record an audit row via the existing `this.audit({...})` helper with
     `kind: 'error'`, `tool: null`, `result: <reason>`, `summary: <message>`
     (truncated by the helper), and the usual `session_key`/`team_id`/`user_id`/
     `profile_id` from `session`. `cost_*` stay null. The error `message` here is
     gateway/SDK-generated, never user/model content, so it is safe in `summary`.
   - Add `'error'` to the `AuditEvent.kind` union in `src/sessions/store.ts:61`.
     No DB migration (no CHECK constraint on `kind`).

5. **Every terminal path is covered by the funnel.** Because the log+audit live in
   the `error` branch of `driveToThread`, all callers benefit — the conversational
   drain (`manager.ts:1126`, which discards the outcome), `runBuild` (`:930`), and
   the exec path (`:1045`). **Intentional:** the exec/build paths additionally audit
   their own lifecycle outcome (e.g. `auditExecEnd`), so an exec error yields *two*
   rows — a low-level `kind:'error'` row (carrying the typed reason) and the
   existing exec-outcome row. Do NOT try to dedupe these; the uniform `kind:'error'`
   telemetry is the point. Note this in your report.

6. **New tests:**
   - `test/manager.test.ts`: drive a `FakeRunner` that yields a terminal `error`
     event (e.g. `reason: 'container_exit'`); assert (a) exactly one
     `store.audits` row with `kind === 'error'`, `result === 'container_exit'`,
     `tool === null`, and the expected `session_key`; (b) the error still posts to
     Slack as before. Use a `console.error` spy (vitest `vi.spyOn`) to assert the
     gateway log line fires. Add a second case asserting `reason: 'timeout'` flows
     through to `result === 'timeout'`.
   - `test/docker.test.ts`: simulate an unexpected child exit with a non-zero code;
     assert the yielded event is `{ type: 'error', reason: 'container_exit', … }`
     and that `message` includes the code. Reuse the existing fake-child seam.

## Hard constraints (do NOT violate)

- The gate (`npm run check`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM
  (`.js` specifiers); inject dependencies (no real Slack/Docker/network in tests).
- **Do NOT touch either `protocol.ts`** — the new `reason` lives on the
  gateway-internal `RunnerEvent`, not the wire `ErrorMessage`. (If you somehow find
  you need a wire change, stop and flag it — you shouldn't.)
- Never log or audit message *contents* or tokens. The error `message` strings here
  are system/SDK-generated (timeouts, exit codes, runner faults) — those are fine.
  Do not start putting reply/plan/prompt text anywhere.
- Keep the audit metadata-only contract: `kind:'error'` rows carry no model output.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — already filed for later)

- Turn-latency / container spawn-duration **metrics** (track `361d52`, T2).
- Surfacing **malformed-protocol-line** skips with session context (track `d185bd`,
  T2) — the silent `continue` on bad JSON stays as-is in this slice.
- Per-tool / per-profile **cost split** (track `a1f221`, T3).
- Auditing the **Slack-post-failure** path (track `0f5922`, T3).
- Any dashboard, log aggregation, structured-JSON logging framework, or correlation
  IDs. This slice is log-line + audit-row only, matching the existing style.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` output (real, not paraphrased).
- Confirm `protocol.ts` was not touched and both copies remain byte-identical.
- Confirm the intentional double-audit on exec/build paths (criterion 5) and that
  no existing audit assertions broke.
- Any deviation from this spec and why.
