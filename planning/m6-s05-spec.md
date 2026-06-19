# Task: M6 S05 — audit layer (gate + lifecycle events) — issue #22 / roadmap M6

You are implementing one well-scoped slice in **slack-agent** (a multi-user Slack bot;
TypeScript, ESM, NodeNext, Node 20+; strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`; **no `any`, no `@ts-ignore`**). Read root `CLAUDE.md` and
`runner/CLAUDE.md` first for conventions and the gate.

This turns on the first slice of M6's **audit layer**: a structured **action/cost
trail — metadata only, never raw message content**. This slice records the
gateway-observable events: the plan gate (approvals/corrections), session lifecycle,
and PR-opened. Cost and the per-tool in-container action log are explicitly later
slices.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate`
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end-to-end in this run.

## Background you need (design is settled — do not re-litigate)

- The audit trail is **metadata only**: identity, action name, result status, latency,
  cost — **never raw message content / reply text / prompts**. This is a hard
  invariant (root `CLAUDE.md`: "Never log message contents"). When in doubt, omit.
- The decided schema was NOT actually shipped — `src/sessions/store.ts` has a
  placeholder `audit_events(id, session_key, event_type, payload, created_at)`. This
  slice **replaces** it with the decided schema (below). There is no production data,
  so just recreate the table (no migration needed).

## Acceptance criteria

1. **Schema** — `audit_events` recreated in `src/sessions/store.ts` `createSchema()` to:
   ```sql
   CREATE TABLE IF NOT EXISTS audit_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     session_key TEXT    NOT NULL,
     team_id     TEXT,
     user_id     TEXT,
     ts          INTEGER NOT NULL,
     kind        TEXT    NOT NULL,   -- 'action'|'approval'|'correction'|'cost'|'lifecycle'
     tool        TEXT,
     summary     TEXT,
     reasoning   TEXT,
     result      TEXT,
     cost_tokens INTEGER
   );
   CREATE INDEX IF NOT EXISTS audit_by_session ON audit_events (session_key);
   CREATE INDEX IF NOT EXISTS audit_by_team    ON audit_events (team_id);
   ```
   (`team_id` is nullable here — the gateway uses an `'unknown'` placeholder / may have
   no team, and the existing `sessions` table keeps `team_id` nullable too. This is a
   deliberate deviation from `design/0002`'s `NOT NULL`.)

2. **`AuditEvent` type + `recordAudit` seam** — in `store.ts`:
   ```ts
   export interface AuditEvent {
     session_key: string;
     team_id: string | null;
     user_id: string | null;
     ts: number;
     kind: 'action' | 'approval' | 'correction' | 'cost' | 'lifecycle';
     tool: string | null;
     summary: string | null;
     reasoning: string | null;
     result: string | null;
     cost_tokens: number | null;
   }
   ```
   Add `recordAudit(event: AuditEvent): void` to the `SessionStore` interface; implement
   in `SqliteSessionStore` (a hoisted prepared INSERT, same style as `stmtRecord`) and
   `NoopSessionStore` (no-op). All fields are required-with-`null` (not optional) so the
   positional bind is total and `exactOptionalPropertyTypes` stays happy.

3. **`pr_opened` gateway-internal event** — add `| { type: 'pr_opened'; url: string }`
   to the `RunnerEvent` union in `src/runner/types.ts`. It is **gateway-internal**,
   exactly like `abandoned` — it is NOT a wire/protocol change, so **do NOT touch
   `protocol.ts` (either copy)**. The `open-pr` node yields it **instead of** the
   current `{ type: 'text', text: 'Opened PR: ${url}' }` (see precedent below).

4. **`Session` carries `teamId`** — add `teamId: string | undefined` to the `Session`
   interface in `src/sessions/manager.ts`, set at creation from `item.teamId` (mirror
   exactly how `requestorUserId` is set), and source it from `row.team_id` on the
   rehydrate path (mirror the `requestorUserId`/`profile_id` row-sourcing added in S04).

5. **Emit audit events from `SessionManager`** (the only place with Slack identity).
   Writes are **best-effort**: wrap each `store.recordAudit(...)` so a store error is
   logged and swallowed, never aborting the turn — copy the existing `try/catch` around
   `store.touch` in the drain loop. The events:

   | When (where) | kind | tool | result | user_id | team_id |
   |---|---|---|---|---|---|
   | session created (`getOrCreate` create path) | `lifecycle` | `session` | `created` | requestor (`item.userId`) | `item.teamId` |
   | session reaped (`reapSession`) | `lifecycle` | `session` | `reaped` | `session.requestorUserId` | `session.teamId` |
   | gate parked (`awaitApproval`) | `approval` | `plan-gate` | `requested` | `session.requestorUserId` | `session.teamId` |
   | gate reply accepted — requestor (`enqueueExisting`, accepted branch) | `approval` | `plan-gate` | `resolved` | `session.requestorUserId` | `session.teamId` |
   | gate reply rejected — non-requestor (`enqueueExisting`, reject branch) | `approval` | `plan-gate` | `rejected_non_requestor` | replier (`item.userId`) | `session.teamId` |
   | run abandoned, `reason === 'cancelled'` (drain loop `abandoned` event) | `correction` | `plan-gate` | `cancelled` | `session.requestorUserId` | `session.teamId` |
   | run abandoned, other reason e.g. `'timed out'` (drain loop) | `approval` | `plan-gate` | `timeout` | `session.requestorUserId` | `session.teamId` |
   | PR opened (drain loop `pr_opened` event) | `action` | `open-pr` | `opened` | `session.requestorUserId` | `session.teamId` |

   - `ts` = `Date.now()`. `summary`/`reasoning`/`cost_tokens` = `null` for every event in
     this slice (no model reasoning is available gateway-side; cost is a later slice).
     **Exception:** the `open-pr` event MAY set `summary = url` (a PR URL is metadata, not
     message content). Reply text / plan text / feedback MUST NOT appear in any field.
   - A small private helper on the manager (e.g. `private audit(partial): void`) that
     fills `ts` and wraps the try/catch keeps call sites terse. Your call on shape.

6. **`pr_opened` still posts to Slack.** When the drain loop handles `pr_opened`, it must
   (a) `updatePlaceholder(... , `Opened PR: ${event.url}`)` — same user-facing text as
   today, so the smoke harness that polls for `Opened PR:` still works — AND (b) record
   the audit action. Do not drop the Slack post when you remove the `text` yield.

7. `npm run gate` green; tests below added/updated; **audit never carries message content.**

## Where to look (precedents to mirror)

- **`recordAudit` mirrors `recordSession`** — `src/sessions/store.ts`: the `SessionStore`
  interface (~L46), the hoisted prepared `stmtRecord` + its typed `db.prepare<[...]>`
  (~L84), `recordSession()` (~L150), and `NoopSessionStore` (~L184). Copy that shape.
- **`pr_opened` mirrors `abandoned`** — the gateway-internal event added for the gate:
  - Declared in `src/runner/types.ts:12` (`{ type: 'abandoned'; reason: string }`).
  - Yielded by a node: `src/oneshot/nodes/plan-gate.ts:57,69`.
  - Threaded up via `yield*` at `src/blueprints/executor.ts:14` and
    `src/oneshot/orchestrator.ts:114` (no change needed there — `yield*` forwards any
    new event type automatically).
  - Handled in the drain loop: `src/sessions/manager.ts` `else if (event.type ===
    'abandoned')`. Add an `else if (event.type === 'pr_opened')` branch next to it.
  - The node to change is `src/oneshot/nodes/open-pr.ts:63` — replace the `text` yield
    with `yield { type: 'pr_opened', url };`.
- **`teamId` on `Session` + row-sourcing on rehydrate** mirrors `requestorUserId` added
  in PR #30 (S04) — `git log -p -1 --grep "requestor-only"` shows the exact pattern in
  `manager.ts` (`getOrCreate` create path, and the rehydrate `getOrCreate` call that
  pulls `row.user_id` / `row.profile_id`).
- Gate emission points live in `manager.ts`: `getOrCreate` (~L68), `enqueueExisting`
  (the `pendingApproval !== null` branch — accepted vs reject sub-branches from S04),
  `awaitApproval` (~L380), `reapSession` (~L184), and the drain loop's event switch.

## Test infrastructure (do not skip — this is where slices fail)

- **Schema + `recordAudit` round-trip** — `test/store.test.ts` uses
  `new SqliteSessionStore(':memory:')` (no disk, no network). Add a `describe` /tests
  that call `recordAudit(...)` then read the row back. There is no public getter for
  audit rows; add a **test-only** read by querying directly is not possible through the
  interface, so either (a) add a minimal `getAuditEvents(session_key): AuditEvent[]`
  method to `SessionStore` (implement in Sqlite + Noop) used by tests, or (b) assert via
  a capturing fake (below). Prefer (a) — a real read-back proves the SQL binds — and it
  is also what a future audit-query slice will need.
- **Manager emission** — `test/manager.test.ts` already has fakes from S04:
  `FakeSlackClient` (`test/responder.test.ts`, captures `posts`/`updates`),
  `GateRunner`/`GateRunnerFactory` (park at a gate), and a `SeededStore implements
  SessionStore`. **Extend the store fake to capture audit events**: add a
  `recordAudit(e) { this.audits.push(e); }` plus `public audits: AuditEvent[] = []` so
  tests can assert what was emitted. (`SeededStore` and `NoopSessionStore` and any other
  `SessionStore` implementer in tests MUST implement the new `recordAudit` — and
  `getAuditEvents` if you add it — or the build breaks.) Assert:
  - a `lifecycle/created` event on session create;
  - `approval/resolved` (requestor) vs `approval/rejected_non_requestor` (bystander) —
    and that **no `summary` field contains the reply text** ('approve' / a feedback
    string), proving content stays out;
  - `correction/cancelled` on a cancel reply (use the `AbandonRunner` pattern already in
    `test/manager.test.ts`);
  - `action/open-pr` when a `pr_opened` event flows (a small runner that yields
    `{ type: 'pr_opened', url: 'http://x/pr/1' }`), and that the placeholder still shows
    `Opened PR:`.
- **open-pr node** — `test/oneshot.test.ts:168` and `:309` assert the first `text` event
  `.toContain('Opened PR:')`. Update these to assert a `pr_opened` event with the URL
  instead (the node no longer yields that text). Check `test/blueprint.test.ts` for any
  similar assertion and update it.

## Hard constraints (do NOT violate)

- `npm run gate` must pass (tsc + runner type-check + vitest + dependency-cruiser). Run
  it yourself and paste the tail. Offline — no Slack/Docker/API/network in tests.
- **No `any`, no `@ts-ignore`.** `exactOptionalPropertyTypes` is on — that is why
  `AuditEvent` fields are `T | null` (always present), not optional.
- **Audit is metadata only — never message content.** No reply text, plan text,
  feedback, prompts, or tool args+results in any audit field. (Root `CLAUDE.md`.)
- **No protocol change.** `pr_opened` goes in `src/runner/types.ts` ONLY; do not touch
  either `protocol.ts` copy. The gateway never imports the Agent SDK or `runner/`.
- Audit writes are **best-effort** — a `recordAudit` throw must be caught and logged,
  never abort a turn (mirror the `store.touch` try/catch).
- `@slack/bolt` stays out of every file except `src/index.ts`.
- Keep the diff focused: `store.ts`, `runner/types.ts`, `oneshot/nodes/open-pr.ts`,
  `sessions/manager.ts`, and the tests above. Match surrounding style + comment density.

## Out of scope (do NOT build)

- `cost` events / token accounting (needs protocol to carry usage — later slice).
- The per-tool in-container **action** log (needs a protocol change — later slice).
- Spend caps, invocation authz, egress-lock, volume GC, durable park — separate M6 slices.
- Any audit-query/read API beyond the minimal `getAuditEvents` test helper.

## When done — report precisely (with REAL command output)

Run and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the full
`npm run gate` tail (with the vitest pass/fail counts). Do NOT claim any change you can't
point to in `git diff` — a coordinator reconciles your summary against the diff, and a
claimed-but-absent change (especially tests) is a failure. Then: (1) files changed + why;
(2) the audit emission points and how you proved content never leaks into a field;
(3) confirm the `test/` files appear in `git diff --stat` and the test count rose vs the
311-test baseline; (4) anything you could NOT satisfy and why. The spec is yours to
implement; do NOT edit this spec file.
