# Task: offline comprehension grader — grade captured coordinator decisions for legibility, write gaps to the ledger

You are implementing one slice in this repository checkout
(`/Users/jedanner/workspace/sa-wt-codex-m7-comprehension-grader`, a git worktree
of slack-agent — TypeScript, Node 20+, ESM, vitest, strict tsc). All paths below
are repo-relative and resolve here. **Read the root `CLAUDE.md` first** (gate,
invariants, conventions). You are on branch `codex/m7-comprehension-grader`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

## Context — read before writing code

This is `track` item **`09a2dd`** — the ACTIVE counterpart to the decision-capture
ledger. A decorrelated grader reads captured coordinator decisions and grades the
**legibility of their reasoning** (can it be explained? failure modes addressed?
cites the SPEC? compliance flags?), writing the gaps back to the audit ledger as a
non-blocking forcing-function. Settled via grill-me; this spec is the contract.

**It is an OFFLINE/BATCH tool, not a live in-turn agent.** It runs out-of-band
(on-demand / cron), never in the plan→build→PR loop. It grades the *captured
reasoning text*, NOT re-verifying builds (diffs/SPECs are gone after session GC).

**Precedents to mirror (both already on this branch's base — `git log --oneline -5`):**
- **PR #69** (`kind:'decision'`) — added the `kind:'decision'` audit stream and the
  `reasoning` column those rows carry. Your grader READS these rows. Find how
  `kind:'decision'` rows are written (`manager.ts` `audit({ kind:'decision',
  tool:'verify', result, reasoning, ... })`) so you grade the right shape.
- **PR #70** (`durations_ms` column) — added a nullable column with a durable
  ALTER-only migration (`store.ts` `auditColumns()` read-before-CREATE, `ALTER ...
  ADD COLUMN` only if absent, never drop) and threaded it through `AuditEvent` +
  the prepared insert + `recordAudit`. Your `graded_audit_id` column is the **same
  shape** — mirror it exactly.

Code this builds on:
- `src/sessions/store.ts` — `SessionStore` interface (`:112`), `SqliteSessionStore`
  (`:180`), `NoopSessionStore` (`:650`); `AuditEvent` (`:57`, **note: it has NO
  `id` field** — the autoincrement PK is not in the `getAuditEvents` projection, so
  your new read needs a projection type that includes `id`); the `kind` union
  (`:63`); the `auditColumns()`/ALTER migration pattern; the prepared insert +
  `recordAudit`; `getAuditEvents` (`:529`) as the read precedent.
- `scripts/smoke-spend.mjs` — the entrypoint convention: a `.mjs` that imports the
  COMPILED build (`../dist/...`), run outside the gate. `package.json` build = `tsc`.

## The design (decided — do not re-derive)

### 1. Schema (store.ts) — mirror #70's column pattern
- Add **`'comprehension'`** to the `AuditEvent['kind']` union.
- Add a new nullable **`graded_audit_id INTEGER`** column to `audit_events`
  (durable ALTER-only migration, exactly like `durations_ms`; read columns before
  CREATE, `ALTER ADD COLUMN` only when absent, never drop). Thread it through
  `AuditEvent` (`graded_audit_id: number | null`), the prepared insert (now 14
  columns), `recordAudit`, and the `getAuditEvents` SELECT list.

### 2. Store read — list ungraded decisions (with their `id`)
Add a `SessionStore` method `listDecisionsToGrade(opts: { sinceMs?: number; limit?:
number }): DecisionToGrade[]` (implement on `SqliteSessionStore`; `NoopSessionStore`
returns `[]`). `DecisionToGrade` is a new exported type = `{ id: number }` plus the
fields the grader needs (`session_key`, `team_id`, `profile_id`, `tool`, `result`,
`reasoning: string`). The query selects `kind='decision'` rows that:
- have **`reasoning IS NOT NULL`** (only decisions captured under `DECISION_CAPTURE`
  can be graded — a null-reasoning row has nothing to grade), AND
- have **no matching `comprehension` row** (`NOT EXISTS (SELECT 1 FROM audit_events
  c WHERE c.kind='comprehension' AND c.graded_audit_id = d.id)`) — the anti-join
  that makes re-runs idempotent, AND
- `d.ts >= sinceMs` when `sinceMs` is given.
Order by `d.id`; apply `LIMIT` when `limit` is given. Add an index on
`graded_audit_id` for the anti-join.

### 3. Orchestration (new `src/telemetry/grade-decisions.ts`) — the testable seam
Export `async function gradeDecisions(deps: { store: SessionStore; grade:
GradeFn; now?: () => number; sinceMs?: number; limit?: number }): Promise<GradeRunSummary>`.
- `GradeFn = (d: DecisionToGrade) => Promise<GradeResult>`, where `GradeResult =
  { verdict: 'clear' | 'thin' | 'opaque'; gaps: string }`. This is the injectable
  seam — the real impl (the LLM call) is supplied by the entrypoint; tests pass a fake.
- For each `listDecisionsToGrade` row: `await grade(d)`, then write ONE audit row
  via the store: `kind:'comprehension'`, `tool:'comprehension'`, `result =
  result.verdict`, `reasoning = result.gaps`, `graded_audit_id = d.id`, copying
  `session_key`/`team_id`/`profile_id` from the decision row, `ts = now()`.
- **Best-effort per row**: a `grade` throw or a write error logs (session key +
  decision id only — never the gap/reasoning content) and continues to the next
  decision; one failure must not abort the batch.
- Return a `GradeRunSummary` (counts only: `graded`, `failed`, and a per-verdict
  tally) for the entrypoint to print. NO message content in the summary.
- This module must NOT import the Agent SDK or call any model — the `grade` seam is
  injected. It stays inside the never-run-agent-code invariant (it's offline tooling
  and is never imported by `src/index.ts`).

### 4. Entrypoint (`scripts/grade-decisions.mjs`) — outside the gate
A `.mjs` mirroring `scripts/smoke-spend.mjs`'s style: import `SqliteSessionStore`
and `gradeDecisions` from `../dist/...`, parse `--db`, `--since`, `--limit` from
argv, build the real `grade` fn as a **dependency-free `fetch` POST to the Anthropic
Messages API** (`https://api.anthropic.com/v1/messages`, `x-api-key` from
`ANTHROPIC_API_KEY`, a current model id, `max_tokens` small) with a senior-engineer
rubric prompt — "grade whether this autonomous decision's stated rationale is
adequately justified: can it be explained, are failure modes addressed, does it
cite the SPEC, any compliance flags — return a verdict (clear/thin/opaque) and
concise gap findings" — parse the response into `{verdict, gaps}`, run
`gradeDecisions`, and print the returned summary. This file is NOT part of `npm run
check` (like the other smokes); keep it dependency-free.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus new ones);
   `diff src/runner/protocol.ts runner/src/protocol.ts` still prints nothing (this
   slice makes no protocol change).
2. `listDecisionsToGrade` returns only `kind:'decision'` rows with non-null
   `reasoning` and no existing `comprehension` row, honoring `sinceMs`/`limit`, each
   carrying its `id`.
3. `gradeDecisions` writes exactly one `kind:'comprehension'` row per returned
   decision: `result` = the verdict, `reasoning` = the gaps, `graded_audit_id` = the
   decision's `id`, with the decision's `session_key`/`team_id`/`profile_id`.
4. Re-running `gradeDecisions` over the same store grades nothing new (the anti-join
   excludes already-graded decisions) — idempotent.
5. A `grade` that throws on one decision is logged and skipped; the rest still grade
   (best-effort), and the summary counts reflect it.
6. New tests (vitest, offline, using a real `SqliteSessionStore` on a temp/in-memory
   DB and a FAKE `GradeFn` — never a real network call): the read filter
   (null-reasoning excluded, already-graded excluded, since/limit honored), the
   comprehension-row write + `graded_audit_id` link, idempotent re-run, the
   best-effort skip, and a `graded_audit_id` store round-trip + legacy-table
   migration (mirror #70's `durations_ms` migration test).

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers).
  `exactOptionalPropertyTypes` is on — `graded_audit_id` and the optional `opts`
  fields are genuinely optional/nullable (conditional-spread idiom).
- **Never log message contents or tokens** — the grader's `reasoning`/`gaps` go ONLY
  into the audit `reasoning` column; logs and the run summary carry counts +
  session/decision ids only, never the gap text or the graded reasoning.
- The new `src/telemetry/grade-decisions.ts` must not import `@anthropic-ai/*` or the
  `runner/` package, and must not be imported by `src/index.ts` — the model call
  lives only in the `.mjs` entrypoint via `fetch`. This keeps the
  never-run-agent-code + minimal-deps invariants intact (no new dependency).
- Touch no `protocol.ts`, no `runner/` package, no gateway turn path. This is purely
  additive offline tooling + one store column + one store read.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- Any LIVE in-turn grading, a second SDK query, or a protocol message — offline only.
- Escalation: no Slack post, alert, or any active surface — gaps are advisory ledger
  rows + the stdout summary only.
- A high-impact/regulated pre-filter on which decisions to grade — grade all
  ungraded (CLI-bounded).
- Structured per-criterion JSON scoring — `result` is the coarse verdict, `reasoning`
  is prose gaps (defer structured extraction, per #69).
- Any read/dashboard for the comprehension rows beyond the run summary.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased); confirm the two
  `protocol.ts` copies still diff clean.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (e.g. the
  `.mjs` entrypoint's prompt/fetch shape, which the offline gate cannot exercise).
