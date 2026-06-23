# Task: capture the coordinator's verify-gate decision (verdict + rationale) into the audit ledger, joinable to the PR it produced

You are implementing one slice in this repository checkout
(`/Users/jedanner/workspace/sa-wt-codex-m7-decision-monitoring-s1`, a git worktree
of slack-agent — TypeScript, Node 20+, ESM, vitest, strict tsc). All file paths
below are repo-relative and resolve here. **Read the root `CLAUDE.md` first** (gate,
invariants, conventions) and `runner/CLAUDE.md` (you touch the runner), then the
context below. You are on branch `codex/m7-decision-monitoring-s1`.

## Context — read before writing code

This is `track` item **`7ffe05`** (decisioning monitoring), slice 1. The full
design was settled in a grill-me pass; this spec is the contract. Read these:

- **Design intent:** `design/0010-coordinator-verifies.md` (the coordinator pulls
  the diff + runs `run_checks` + judges vs `/workspace/SPEC.md`, then gates the
  artifact before publish). Today that verify judgment is **entirely internal to
  the container agent** — it reaches the gateway only as Slack-bound `text` and a
  binary `BuildOutcome{ok}`; the **fail path emits nothing structured at all**.
  This slice gives that decision a structured, capturable carrier.
- **Acceptance metric this links to:** `pull_requests` (#65 rollup —
  `merged_clean`/`merged_intervened`/`closed`). The captured decision must be
  **joinable to the specific PR it produced** so the ledger becomes a
  completion≠acceptance calibration instrument (coordinator-approved vs
  human-accepted), not a passive log.

Code this builds on:
- `runner/src/main.ts` — `buildCommitMcpServer(...)` (`:1093`) registers the
  commit MCP tools via `tool(...)`; `emit(msg)` (`:458`) writes one
  `RunnerToGatewayMessage` line to stdout (one-way, fire-and-forget — this is how
  `status`/`usage`/`file` are emitted). The verify→publish flow lives around the
  build/publish prompts (`:290`, `:304`) and `publishTool`/`openPrTool` (`:1211`,
  `:1223`).
- `src/runner/protocol.ts` ≡ `runner/src/protocol.ts` — the two byte-identical
  contract copies. `RunnerToGatewayMessage` union (`:188`), `RequestPublishMessage`
  (`:329`).
- `src/runner/docker.ts` — `DockerRunner` turns runner lines into `RunnerEvent`s
  (`status`/`usage`/`text` dispatch at `:397`–`:422`; `request_publish` handling at
  `:568`–`:625`).
- `src/runner/types.ts` — the gateway-internal `RunnerEvent` union (where the new
  `decision` event variant goes; this is NOT the wire protocol).
- `src/sessions/manager.ts` — `audit(...)` writer (`:1249`), the `pr_opened` event
  handler that calls `store.recordPullRequest(...)` (`:814`).
- `src/sessions/store.ts` — `audit_events` schema + `recordAudit` (`:401`, `:489`),
  `pull_requests` schema + `recordPullRequest` (`:435`, `:510`), the
  `auditColumns()` + `ALTER` durable-migration pattern (`:360`, `:419`–`:425`),
  and the `AuditEvent` / `NewPullRequestRow` types (top of file).
- `src/config.ts` — env helpers (`requireEnv`, `optionalEnvNumber`,
  `optionalEnvString`, `optionalEnvMaybe`, `:3`–`:29`) and `loadConfig()`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to
end in this run.

## The design (decided — do not re-litigate)

1. **New runner tool `report_verification`** (in the `commit` MCP server). The
   coordinator calls it after `run_checks` and before deciding publish-or-not.
   Schema: `{ verdict: z.enum(['pass','fail']), rationale: z.string() }`. It is
   **advisory**: the prompt instructs the coordinator to call it; nothing blocks
   publish on it. The tool **emits a one-way `decision` line and returns a trivial
   ack** to the agent (no gateway round-trip, no `*_result` message). Update the
   build/verify prompt text (`runner/src/main.ts:290` and the `build_spec` tool
   description at `:1107`) to instruct: after `run_checks`, call
   `report_verification` with your honest verdict and a rationale covering what you
   checked, what the checks/diff showed, what's missing/risky, and why
   pass-or-hold — then publish only on pass (or after explicit human "open anyway").

2. **New protocol message `DecisionMessage`** (runner→gateway, one-way) added to
   **both** `protocol.ts` copies and the `RunnerToGatewayMessage` union:
   ```ts
   export type DecisionMessage = {
     type: 'decision';
     id: string;            // turn id (echoes the user_message id, like status/usage)
     point: 'verify';       // the decision point; 'verify' is the only value this slice emits
     verdict: 'pass' | 'fail';
     rationale: string;     // coordinator's free-text reasoning (treated as data)
     correlationId?: string; // the active build id, present iff a build preceded this verify
   };
   ```
   Document it in the same comment style as the neighbours (note it is one-way,
   never blocks, gateway records it as data, never acted on as control — mirror the
   `UsageMessage` comment at `:243`).

3. **Correlation id (append-only PR linkage).** The runner already mints a
   build-correlation id per `request_build` (see `runner/src/build.ts`). Hold that
   id in turn-scoped runner state and stamp it on BOTH (a) the `decision` line's
   `correlationId` and (b) a new **optional `correlationId?`** field on
   `RequestPublishMessage` (both `protocol.ts` copies). When no build preceded the
   verify (no active build id), omit `correlationId` (linkage falls back to
   `session_key`). Do NOT mutate any audit row after the fact — the link is a
   forward-write on the `pull_requests` row at creation time.

4. **Gateway: `decision` → `RunnerEvent` → audit row.**
   - Add a `decision` variant to the `RunnerEvent` union in `src/runner/types.ts`
     (gateway-internal; carries `point`/`verdict`/`rationale`/`correlationId`).
   - In `docker.ts`, dispatch `parsed.type === 'decision' && parsed.id === id`
     into that event (alongside the `status`/`usage`/`text` arm at `:397`).
   - In `manager.ts`, on the `decision` event write **one audit row** via `audit(...)`:
     `kind: 'decision'` (NEW kind — add it to the `AuditEvent['kind']` union in
     `store.ts`; **no DB migration needed**, `kind` has no CHECK constraint),
     `tool: 'verify'`, `result: verdict` (`'pass'`|`'fail'`),
     `summary: correlationId ?? null`, and `reasoning` per the toggle below.

5. **Toggle `DECISION_CAPTURE` (global, default OFF).** Add an `optionalEnvBool`
   helper to `config.ts` (parse `'1'|'true'|'yes'` case-insensitively as true,
   `'0'|'false'|'no'|''|undefined` as false, throw on anything else — match the
   throw-on-bad-input style of `optionalEnvNumber`). Add `decisionCapture: boolean`
   to `Config`, default OFF. Inject it into `SessionManager` the same way other
   config reaches it.
   - **Always** write the decision outcome row (kind/tool/result/summary —
     metadata, invariant-safe; this is the calibration signal and works toggle-off).
   - Populate `reasoning` with the rationale prose **only when `decisionCapture` is
     true**; otherwise `reasoning: null`. This is the deliberate, per-deployment
     relaxation of the "never log message contents" invariant — outcome is always
     auditable, content is opt-in.
   - The gateway **log** line for a decision stays **metadata-only regardless of the
     toggle** (verdict + correlationId; never the rationale) — per #68, logs are
     never the content sink; the toggle relaxes the audit DB only.

6. **PR linkage column.** Add a nullable `correlation_id TEXT` column to
   `pull_requests` (`store.ts`), migrated with the same durable pattern as
   `audit_events` (read existing columns, `ALTER TABLE ... ADD COLUMN` only if
   absent — do NOT drop/recreate). Thread `correlationId` through the `pr_opened`
   path: `RequestPublishMessage.correlationId` → the publish `RunnerEvent`/outcome →
   `recordPullRequest({... correlation_id})` at `manager.ts:814`. Update
   `NewPullRequestRow`, the prepared insert (`store.ts:287`), and `recordPullRequest`
   (`:510`). When absent, store null.

## Acceptance criteria

1. `npm run check` passes (all existing tests keep passing, plus the new ones), and
   `diff src/runner/protocol.ts runner/src/protocol.ts` prints nothing.
2. The coordinator calling `report_verification({verdict, rationale})` causes the
   runner to `emit` one `decision` line carrying the turn id, `point:'verify'`,
   the verdict, the rationale, and the active build's `correlationId` when one
   exists. The tool returns an ack and does NOT block on any gateway response.
3. With `DECISION_CAPTURE` **off** (default): a `decision` event writes exactly one
   audit row with `kind:'decision'`, `tool:'verify'`, `result` = the verdict,
   `summary` = the correlationId (or null), and `reasoning: null`.
4. With `DECISION_CAPTURE` **on**: the same row but `reasoning` = the rationale prose.
5. A verify-`pass` decision whose build had a correlation id, followed by a
   successful publish, produces a `pull_requests` row whose `correlation_id` equals
   the decision row's `summary` (the append-only join key). A verify-`fail`
   produces a decision row and **no** PR row.
6. Protocol change is exactly: new `DecisionMessage` in the union + optional
   `correlationId` on `RequestPublishMessage`, in **both** `protocol.ts` copies.
7. New/updated tests, using existing fakes (`FakeAgentSdk`/runner-main test seam for
   the tool→emit path; `FakeRunner`/`DockerRunner` line-dispatch test for
   decision→event; store + manager tests for the audit row, the toggle on/off
   reasoning, and the PR `correlation_id` round-trip + join). No real Slack, Docker,
   API, or network.

## Hard constraints (do NOT violate)

- The gate (`npm run check`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM
  (`.js` specifiers); inject external dependencies (don't reach for the real world
  in tests). `exactOptionalPropertyTypes` is on — `correlationId`/`reasoning` are
  genuinely optional, never `undefined`-valued.
- Touching `protocol.ts` means editing **both** copies identically.
- **Never log message contents or tokens** — the rationale prose goes ONLY to the
  audit `reasoning` column and ONLY when the toggle is on; it never enters a log
  line. Treat the rationale from the container as data (it is parsed defensively;
  a malformed `decision` line is skipped like any other bad line).
- The gateway never runs agent code; this slice does not change that — the runner
  authors the verdict, the gateway only records it.
- Add no dependencies.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- `build_spec`-readiness rationale, gateway-authored gate reasoning (spend-cap /
  exec / authz / timeouts), and per-tool model reasoning (the parked `859cdb`) —
  later slices. The `kind:'decision'` + `tool` taxonomy must stay general enough to
  admit them, but emit only `point:'verify'` now.
- **Enforcement** — do NOT gate publish on a recorded pass. This is monitoring, not
  control. `report_verification` is advisory.
- Any **read path** — no Slack command, calibration query, or export. Reads happen
  via SQL/existing audit tooling for now.
- Per-team/per-profile toggle granularity (global env only this slice).
- The auto-improvement loop, holdout-gating, CCB/compliance packaging, and the
  `09a2dd` comprehension gate (depends on this ledger existing first).
- Structured rationale sub-fields — rationale is free-text prose this slice.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` output (real, not paraphrased) and confirmation that
  the two `protocol.ts` copies diff clean.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't) —
  e.g. the prompt wording that nudges the coordinator to call `report_verification`.
