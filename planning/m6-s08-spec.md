# Task: spend-caps Slice B0 — make the audit_events cost ledger durable + trustworthy

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` and
`runner/CLAUDE.md` first** (gate, invariants, conventions), then the context below.
You are on branch `sonnet/m6-s08-ledger-durability`, working in this worktree.

## Context — read before writing code

Slice A (just merged, PR #37) records per-turn cost to `audit_events`
(`cost_micro_usd` column, `kind:'cost'` rows). **Slice B (enforcement) will treat
`audit_events` as a rolling-24h ledger** — caps become `SUM(cost_micro_usd) WHERE …
ts > now-24h`. This slice (B0) is the **foundation that makes that ledger trustworthy**.
There is **no enforcement here** — no caps, no limits, no env knobs, no `SUM` queries,
no behavior change a user can see. Three things only:

1. **Durability.** `createSchema()` currently runs `DROP TABLE IF EXISTS audit_events`
   on **every** startup (`src/sessions/store.ts:~225`). That was an S05 one-time
   cleanup of a stale placeholder, but it wipes the whole ledger on every restart —
   fatal for a rolling-24h `SUM`. Replace it with a durable schema + migration.
2. **Query indexes.** Add the `(user_id, ts)` and `(ts)` indexes the Slice B `SUM`
   queries will need.
3. **Trust-boundary validation.** The cost/token fields arrive from the container over
   NDJSON and are stored unvalidated today. Coerce them at the boundary so the ledger
   only ever holds non-negative integers (a misreporting/compromised sandbox must not be
   able to skew the cap). Per the project invariant: *treat everything from a container
   as data.*

Code this builds on (line numbers from the post-Slice-A tree):
- `src/sessions/store.ts` — `createSchema()` (~197–243, including the `DROP TABLE` at
  ~225 and the `audit_events` `CREATE TABLE` with `cost_micro_usd`); constructor
  (~129–132) which calls `this.db.pragma('journal_mode = WAL')` then `createSchema()`.
- `src/runner/docker.ts` — the wire→`RunnerEvent` dispatch (~313–343), including the
  `usage` branch added in Slice A.
- `test/store.test.ts` — store tests, currently **`:memory:` only** (see its header).
- `test/docker.test.ts` — `DockerRunner` tests via `FakeChildProcess` with a
  "simulate the runner writing a line to stdout" helper (~line 42).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure. You must NOT edit this spec.

## The change, step by step

### 1. Durable schema + migration (`src/sessions/store.ts`)

Rewrite `createSchema()` so `audit_events` survives restarts and existing DBs migrate
cleanly. Read the existing columns **before** creating the table, then:

- **Drop ONLY the recognised pre-S05 placeholder**, never a real ledger. The placeholder
  had an `event_type`/`payload` shape with no `session_key`; it was never written to, so
  dropping just that shape is lossless.
- `CREATE TABLE IF NOT EXISTS audit_events (…)` with the **current 11-column shape**
  (the same columns Slice A left, including `cost_micro_usd INTEGER`). Fresh DBs get the
  full schema; existing real tables are untouched by `IF NOT EXISTS`.
- **Migrate older real tables** (created between S05 and Slice A — they have
  `session_key` but not `cost_micro_usd`): `ALTER TABLE audit_events ADD COLUMN
  cost_micro_usd INTEGER`.
- Create all indexes with `IF NOT EXISTS` (existing two + two new).
- Stamp `PRAGMA user_version = 1` as the schema-version marker for future migrations.

Concretely (adapt names/style to the file; this is the logic, not a copy target):

```ts
private auditColumns(): string[] {
  const rows = this.db.pragma('table_info(audit_events)') as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

private createSchema(): void {
  // sessions table + its indexes — UNCHANGED from today (keep as-is).
  this.db.exec(`CREATE TABLE IF NOT EXISTS sessions ( … ); CREATE INDEX …`);

  // audit_events: durable across restarts (no unconditional DROP).
  const auditCols = this.auditColumns();           // [] when the table is absent
  // One-time cleanup of the pre-S05 placeholder (event_type/payload, no session_key),
  // which was never written to. A real ledger (has session_key) is never dropped.
  if (auditCols.length > 0 && !auditCols.includes('session_key')) {
    this.db.exec('DROP TABLE audit_events');
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key  TEXT    NOT NULL,
      team_id      TEXT,
      user_id      TEXT,
      ts           INTEGER NOT NULL,
      kind         TEXT    NOT NULL,
      tool         TEXT,
      summary      TEXT,
      reasoning    TEXT,
      result       TEXT,
      cost_tokens  INTEGER,
      cost_micro_usd INTEGER
    );
  `);
  // Migrate a pre-cost-column real table (post-S05, pre-Slice-A).
  if (auditCols.includes('session_key') && !auditCols.includes('cost_micro_usd')) {
    this.db.exec('ALTER TABLE audit_events ADD COLUMN cost_micro_usd INTEGER');
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS audit_by_session ON audit_events (session_key);
    CREATE INDEX IF NOT EXISTS audit_by_team    ON audit_events (team_id);
    CREATE INDEX IF NOT EXISTS audit_by_user_ts ON audit_events (user_id, ts);
    CREATE INDEX IF NOT EXISTS audit_by_ts      ON audit_events (ts);
  `);
  this.db.pragma('user_version = 1');
}
```

Order matters: read `auditColumns()` **before** the `CREATE`, so a fresh DB sees `[]`
and skips both the placeholder-drop and the `ALTER` (the `CREATE` already gives it the
column). Verify the branch table by reasoning through fresh / old-10-col / placeholder.

`db.pragma(...)` is already used in the constructor — keep that API. If the
`table_info` cast trips strict typing, type it as `Array<{ name: string }>` (no `any`,
no `@ts-ignore`).

### 2. Trust-boundary validation (`src/runner/docker.ts`)

The five numeric fields on the `usage` wire message cross the container trust boundary.
Add a module-level coercion helper and apply it in the `usage` dispatch branch:

```ts
// Cost/token fields come from the container — coerce each to a non-negative integer
// (missing / non-finite / negative / non-number → 0) so neither the audit ledger nor
// the Slice-B SUM cap can be skewed by a misreporting sandbox.
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}
```

In the existing `} else if (parsed.type === 'usage' && parsed.id === id) {` branch,
wrap every field: `costMicroUsd: toCount(parsed.costMicroUsd)`, and likewise
`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens`. Keep the
`as RunnerEvent` cast style already in that block. Do not change any other branch.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the new ones). Run it
   from the worktree root.
2. `audit_events` rows **survive a restart**: opening a second `SqliteSessionStore` on
   the same on-disk DB path preserves previously-recorded audit rows (no `DROP`).
3. An existing DB whose `audit_events` predates `cost_micro_usd` is **migrated** on open
   (column added, existing rows preserved and readable, new `kind:'cost'` writes work).
4. The pre-S05 placeholder shape (`event_type`/`payload`, no `session_key`) is replaced
   on open and the store works normally afterward.
5. The `audit_by_user_ts (user_id, ts)` and `audit_by_ts (ts)` indexes exist after open.
6. Malformed `usage` fields from the container (negative, non-finite, non-number,
   missing) are coerced to `0` in the yielded `RunnerEvent`; valid values round to a
   non-negative integer. No other dispatch branch changes behavior.

### New tests (use the existing fakes/seams — offline, no network/Slack/Docker/API)

- **`test/store.test.ts`** — these need a real **temp file** DB (so two connections share
  state); `:memory:` is per-connection and can't test persistence. Use
  `fs.mkdtempSync(path.join(os.tmpdir(), 'sa-store-'))`, build the path, and **clean up
  in `afterEach`/`finally`**. Update the file's header comment (it says `:memory:` only /
  no files on disk) to note the durability/migration tests deliberately use a temp file.
  - **Durability:** open store, `recordAudit`, open a *second* store on the same path,
    assert `getAuditEvents` still returns the row.
  - **Migration:** with a raw `better-sqlite3` `Database` on a temp path, create the old
    10-column `audit_events` (no `cost_micro_usd`) and insert one row; close; then
    `new SqliteSessionStore(path)`; assert the old row is preserved and readable, the
    column now exists (round-trips `null` for the old row), and a fresh `kind:'cost'`
    write with a `cost_micro_usd` value round-trips.
  - **Placeholder:** raw-create a placeholder table (`id, event_type, payload`) on a temp
    path, then open `SqliteSessionStore`, assert a normal `recordAudit` + `getAuditEvents`
    works (the incompatible table was replaced).
  - **Indexes:** after open, assert both new index names exist (query `sqlite_master`
    `WHERE type='index'`, or `PRAGMA index_list(audit_events)`).
- **`test/docker.test.ts`** — drive a turn (mirror an existing `usage`/`text` test in
  this file) and push a `usage` line with bad fields (e.g. `costMicroUsd: -5`,
  `inputTokens: "x"`, a missing field, and a non-finite value if expressible); assert the
  yielded `usage` `RunnerEvent` has those fields at `0`. Add one well-formed case
  (e.g. `1.6` → `2`) to show rounding/pass-through.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **tail** of its real output (with test
  counts) when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); inject deps in tests.
- **Do not weaken or delete the existing "schema is created idempotently (two opens
  against `:memory:` …)" test** — confirm it still passes (two `:memory:` opens are
  independent DBs, so removing the `DROP` does not change its outcome). If it somehow
  depends on the `DROP`, fix the test to assert the real intent, do not delete coverage.
- Never log message contents or tokens (the cost numbers go to the DB only).
- The gateway never imports the Agent SDK or the `runner/` package (boundary-enforced).
- Add no dependencies (`better-sqlite3` is already a dep; `node:fs`/`node:os`/`node:path`
  are built-ins).
- Do NOT commit — leave the working tree for review. Do NOT edit this spec.

## Out of scope (do NOT build — these are Slice B1 / enforcement)

- Any enforcement: caps, env knobs, `SUM`-over-ledger checks, admission reject, mid-task
  abandon, Slack cap messages. **None of it.** This slice is foundation only.
- No changes to the `usage` protocol message, the runner, `FakeRunner`, or the manager
  drain loop (the `kind:'cost'` recording stays exactly as Slice A left it).
- No pruning/retention of old audit rows (a durable table grows; retention, if ever
  wanted, is later and separate).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, with test counts).
- Baseline test count before your change vs after.
- Confirm by reasoning: fresh DB, old-10-column DB, and placeholder DB each end with the
  correct 11-column schema + indexes.
- Any deviation from this spec and why.
