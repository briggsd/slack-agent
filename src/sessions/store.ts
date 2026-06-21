/**
 * SessionStore — persisted index of gateway sessions.
 *
 * Schema from design/0002 §2. Columns the gateway doesn't yet populate
 * (sdk_session_id, harness_version, volume_name) are left nullable and
 * unset in this slice — they're wired up in later milestones.
 *
 * The audit_events table records the gateway-observable action/lifecycle trail
 * (M6 audit layer, S05). Metadata only — never raw message content.
 */
import Database from 'better-sqlite3';

export type SessionStatus = 'active' | 'reaped';

export interface SessionRow {
  session_key: string;
  team_id: string | null;
  user_id: string | null;
  channel_id: string;
  thread_ts: string;
  profile_id: string;
  /** Populated by a later protocol slice — leave null for now. */
  harness_version: string | null;
  /** Populated by a later protocol slice — leave null for now. */
  sdk_session_id: string | null;
  /** Recomputable from key; populated by a later slice. */
  volume_name: string | null;
  created_at: number;
  last_active_at: number;
  status: SessionStatus;
}

/** Minimal shape required to record a new session. */
export type NewSessionRow = Pick<
  SessionRow,
  | 'session_key'
  | 'team_id'
  | 'user_id'
  | 'channel_id'
  | 'thread_ts'
  | 'profile_id'
  | 'harness_version'
  | 'created_at'
  | 'last_active_at'
  | 'status'
>;

/**
 * A single row in the audit_events table.
 *
 * All fields are required-with-null (never optional) so the positional bind is
 * total and exactOptionalPropertyTypes stays happy. Audit is metadata only —
 * never raw message content (no reply text, plan text, feedback, prompts).
 */
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
  cost_micro_usd: number | null;
}

export interface PullRequestRow {
  id: number;
  session_key: string;
  team_id: string | null;
  repo: string;
  pr_number: number;
  head_sha: string;
  profile_id: string;
  opened_at: number;
  state: string;
  last_polled_at: number | null;
  resolved_at: number | null;
}

/** Minimal shape required to record a newly opened pull request. */
export type NewPullRequestRow = Pick<
  PullRequestRow,
  'session_key' | 'team_id' | 'repo' | 'pr_number' | 'head_sha' | 'profile_id' | 'opened_at'
>;

export interface SessionStore {
  /** Insert or replace the row when a session is created. */
  recordSession(row: NewSessionRow): void;
  /** Bump last_active_at (called each drain turn). */
  touch(key: string, atMs: number): void;
  /** Update status (called on reap). */
  setStatus(key: string, status: SessionStatus): void;
  /** Fetch a row by session key (undefined when not found). */
  get(key: string): SessionRow | undefined;
  /** Append an audit event row (best-effort — callers must catch). */
  recordAudit(event: AuditEvent): void;
  /** Record a newly opened PR for later reconciliation. */
  recordPullRequest(row: NewPullRequestRow): void;
  /**
   * Read back audit rows for a session key. Test/diagnostic helper only — it is NOT
   * tenancy-scoped (no team_id filter). Add a mandatory team scope (WHERE session_key =
   * ? AND team_id = ?) before any user-facing query path consumes this.
   */
  getAuditEvents(sessionKey: string): AuditEvent[];
  /**
   * Reconciliation worklist helper: list only rows still marked open. NOT
   * tenancy-scoped (no team_id filter). The slice-3 acceptance-rate rollup must
   * scope by team (WHERE team_id = ?) before any user-facing query path consumes
   * pull_requests data — the row carries team_id for exactly that.
   */
  listOpenPullRequests(): PullRequestRow[];
  /** Rows whose last_active_at is strictly older than `cutoffMs` (uses the
   *  sessions_last_active_at index). For the volume-GC sweep. */
  listExpired(cutoffMs: number): SessionRow[];
  /** Delete a session row by key (volume-GC removes the row once its volume is gone). */
  deleteSession(key: string): void;
  /** Close the underlying database handle. */
  close(): void;
  /** Σ cost_micro_usd for a session (lifetime). 0 when none. */
  sumCostByTask(sessionKey: string): number;
  /** Σ cost_micro_usd for a user since `sinceMs` (rolling window). 0 when none. */
  sumCostByUserSince(userId: string, sinceMs: number): number;
  /** Σ cost_micro_usd across all sessions since `sinceMs`. 0 when none. */
  sumCostGlobalSince(sinceMs: number): number;
  /** True only when the gateway has a standing human opt-in for ungated exec. */
  hasExecOptIn(teamId: string, userId: string): boolean;
  /** Record a standing human opt-in for ungated exec. Admin/operator seam; not user-chat driven. */
  recordExecOptIn(teamId: string, userId: string, atMs: number): void;
}

// ─── SQLite implementation ────────────────────────────────────────────────────

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;
  private readonly stmtRecord: Database.Statement<[
    string,
    string | null,
    string | null,
    string,
    string,
    string,
    string | null,
    number,
    number,
    string,
  ]>;
  private readonly stmtTouch: Database.Statement<[number, string]>;
  private readonly stmtSetStatus: Database.Statement<[string, string]>;
  private readonly stmtGet: Database.Statement<[string], SessionRow>;
  private readonly stmtRecordAudit: Database.Statement<[
    string,
    string | null,
    string | null,
    number,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
    number | null,
    number | null,
  ]>;
  private readonly stmtRecordPullRequest: Database.Statement<
    [string, string | null, string, number, string, string, number]
  >;
  private readonly stmtGetAudit: Database.Statement<[string], AuditEvent>;
  private readonly stmtListOpenPullRequests: Database.Statement<[], PullRequestRow>;
  private readonly stmtListExpired: Database.Statement<[number], SessionRow>;
  private readonly stmtDeleteSession: Database.Statement<[string]>;
  private readonly stmtSumByTask: Database.Statement<[string], { total: number }>;
  private readonly stmtSumByUserSince: Database.Statement<[string, number], { total: number }>;
  private readonly stmtSumGlobalSince: Database.Statement<[number], { total: number }>;
  private readonly stmtHasExecOptIn: Database.Statement<[string, string], { present: number }>;
  private readonly stmtRecordExecOptIn: Database.Statement<[string, string, number]>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();

    // Hoist all prepared statements so they are compiled once, not per-call.
    this.stmtRecord = this.db.prepare<[
      string,
      string | null,
      string | null,
      string,
      string,
      string,
      string | null,
      number,
      number,
      string,
    ]>(`
      INSERT INTO sessions
        (session_key, team_id, user_id, channel_id, thread_ts, profile_id,
         harness_version, created_at, last_active_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        last_active_at = excluded.last_active_at,
        status = 'active'
    `);

    this.stmtTouch = this.db.prepare<[number, string]>(
      'UPDATE sessions SET last_active_at = ? WHERE session_key = ?',
    );

    this.stmtSetStatus = this.db.prepare<[string, string]>(
      'UPDATE sessions SET status = ? WHERE session_key = ?',
    );

    this.stmtGet = this.db.prepare<[string], SessionRow>(
      'SELECT * FROM sessions WHERE session_key = ?',
    );

    this.stmtRecordAudit = this.db.prepare<[
      string,
      string | null,
      string | null,
      number,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      number | null,
    ]>(`
      INSERT INTO audit_events
        (session_key, team_id, user_id, ts, kind, tool, summary, reasoning, result, cost_tokens, cost_micro_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetAudit = this.db.prepare<[string], AuditEvent>(
      'SELECT session_key, team_id, user_id, ts, kind, tool, summary, reasoning, result, cost_tokens, cost_micro_usd FROM audit_events WHERE session_key = ? ORDER BY id',
    );

    this.stmtRecordPullRequest = this.db.prepare<
      [string, string | null, string, number, string, string, number]
    >(`
      INSERT INTO pull_requests
        (session_key, team_id, repo, pr_number, head_sha, profile_id, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtListOpenPullRequests = this.db.prepare<[], PullRequestRow>(
      "SELECT * FROM pull_requests WHERE state = 'open' ORDER BY id",
    );

    this.stmtListExpired = this.db.prepare<[number], SessionRow>(
      // Bounded so one sweep can't materialize an unbounded backlog; the remainder is
      // drained by subsequent sweeps (oldest first).
      'SELECT * FROM sessions WHERE last_active_at < ? ORDER BY last_active_at LIMIT 500',
    );

    this.stmtDeleteSession = this.db.prepare<[string]>(
      'DELETE FROM sessions WHERE session_key = ?',
    );

    this.stmtSumByTask = this.db.prepare<[string], { total: number }>(
      'SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE session_key = ?',
    );

    this.stmtSumByUserSince = this.db.prepare<[string, number], { total: number }>(
      'SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE user_id = ? AND ts > ?',
    );

    this.stmtSumGlobalSince = this.db.prepare<[number], { total: number }>(
      'SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE ts > ?',
    );

    this.stmtHasExecOptIn = this.db.prepare<[string, string], { present: number }>(
      'SELECT 1 AS present FROM exec_opt_ins WHERE team_id = ? AND user_id = ? LIMIT 1',
    );

    this.stmtRecordExecOptIn = this.db.prepare<[string, string, number]>(`
      INSERT INTO exec_opt_ins (team_id, user_id, granted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(team_id, user_id) DO UPDATE SET granted_at = excluded.granted_at
    `);
  }

  /**
   * Read the current column names from audit_events (returns [] when the table does not
   * exist yet). Called before CREATE TABLE IF NOT EXISTS so a fresh DB sees [] and skips
   * both the placeholder-drop and the ALTER migration.
   */
  private auditColumns(): string[] {
    const rows = this.db.pragma('table_info(audit_events)') as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private createSchema(): void {
    // sessions table + its indexes — unchanged from before this slice.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key      TEXT    PRIMARY KEY,
        team_id          TEXT,
        user_id          TEXT,
        channel_id       TEXT    NOT NULL,
        thread_ts        TEXT    NOT NULL,
        profile_id       TEXT    NOT NULL,
        harness_version  TEXT,
        sdk_session_id   TEXT,
        volume_name      TEXT,
        created_at       INTEGER NOT NULL,
        last_active_at   INTEGER NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS sessions_team_id
        ON sessions (team_id);

      CREATE INDEX IF NOT EXISTS sessions_last_active_at
        ON sessions (last_active_at);
    `);

    // audit_events: durable across restarts (no unconditional DROP).
    // Read columns BEFORE the CREATE so a fresh DB sees [] and skips both branches below.
    const auditCols = this.auditColumns();

    // One-time cleanup of the pre-S05 placeholder shape (event_type/payload, no
    // session_key). The placeholder was never written to, so this is lossless. A real
    // ledger (one that has a session_key column) is NEVER dropped.
    if (auditCols.length > 0 && !auditCols.includes('session_key')) {
      this.db.exec('DROP TABLE audit_events');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key    TEXT    NOT NULL,
        team_id        TEXT,
        user_id        TEXT,
        ts             INTEGER NOT NULL,
        kind           TEXT    NOT NULL,
        tool           TEXT,
        summary        TEXT,
        reasoning      TEXT,
        result         TEXT,
        cost_tokens    INTEGER,
        cost_micro_usd INTEGER
      );
    `);

    // Migrate a post-S05 / pre-Slice-A table that has session_key but not cost_micro_usd.
    if (auditCols.includes('session_key') && !auditCols.includes('cost_micro_usd')) {
      this.db.exec('ALTER TABLE audit_events ADD COLUMN cost_micro_usd INTEGER');
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS audit_by_session ON audit_events (session_key);
      CREATE INDEX IF NOT EXISTS audit_by_team    ON audit_events (team_id);
      CREATE INDEX IF NOT EXISTS audit_by_user_ts ON audit_events (user_id, ts);
      CREATE INDEX IF NOT EXISTS audit_by_ts      ON audit_events (ts);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key    TEXT    NOT NULL,
        team_id        TEXT,
        repo           TEXT    NOT NULL,
        pr_number      INTEGER NOT NULL,
        head_sha       TEXT    NOT NULL,
        profile_id     TEXT    NOT NULL,
        opened_at      INTEGER NOT NULL,
        state          TEXT    NOT NULL DEFAULT 'open',
        last_polled_at INTEGER,
        resolved_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS pr_by_state ON pull_requests (state);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exec_opt_ins (
        team_id    TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
    `);
  }

  recordSession(row: NewSessionRow): void {
    this.stmtRecord.run(
      row.session_key,
      row.team_id,
      row.user_id,
      row.channel_id,
      row.thread_ts,
      row.profile_id,
      row.harness_version,
      row.created_at,
      row.last_active_at,
      row.status,
    );
  }

  touch(key: string, atMs: number): void {
    this.stmtTouch.run(atMs, key);
  }

  setStatus(key: string, status: SessionStatus): void {
    this.stmtSetStatus.run(status, key);
  }

  get(key: string): SessionRow | undefined {
    return this.stmtGet.get(key);
  }

  recordAudit(event: AuditEvent): void {
    this.stmtRecordAudit.run(
      event.session_key,
      event.team_id,
      event.user_id,
      event.ts,
      event.kind,
      event.tool,
      event.summary,
      event.reasoning,
      event.result,
      event.cost_tokens,
      event.cost_micro_usd,
    );
  }

  getAuditEvents(sessionKey: string): AuditEvent[] {
    return this.stmtGetAudit.all(sessionKey);
  }

  recordPullRequest(row: NewPullRequestRow): void {
    this.stmtRecordPullRequest.run(
      row.session_key,
      row.team_id,
      row.repo,
      row.pr_number,
      row.head_sha,
      row.profile_id,
      row.opened_at,
    );
  }

  listOpenPullRequests(): PullRequestRow[] {
    return this.stmtListOpenPullRequests.all();
  }

  listExpired(cutoffMs: number): SessionRow[] {
    return this.stmtListExpired.all(cutoffMs);
  }

  deleteSession(key: string): void {
    this.stmtDeleteSession.run(key);
  }

  sumCostByTask(sessionKey: string): number {
    return this.stmtSumByTask.get(sessionKey)?.total ?? 0;
  }

  sumCostByUserSince(userId: string, sinceMs: number): number {
    return this.stmtSumByUserSince.get(userId, sinceMs)?.total ?? 0;
  }

  sumCostGlobalSince(sinceMs: number): number {
    return this.stmtSumGlobalSince.get(sinceMs)?.total ?? 0;
  }

  hasExecOptIn(teamId: string, userId: string): boolean {
    return this.stmtHasExecOptIn.get(teamId, userId) !== undefined;
  }

  recordExecOptIn(teamId: string, userId: string, atMs: number): void {
    this.stmtRecordExecOptIn.run(teamId, userId, atMs);
  }

  close(): void {
    this.db.close();
  }
}

// ─── In-memory no-op store (for tests that don't need persistence) ───────────

/** A no-op implementation that satisfies the interface but stores nothing. */
export class NoopSessionStore implements SessionStore {
  recordSession(_row: NewSessionRow): void { /* no-op */ }
  touch(_key: string, _atMs: number): void { /* no-op */ }
  setStatus(_key: string, _status: SessionStatus): void { /* no-op */ }
  get(_key: string): SessionRow | undefined { return undefined; }
  recordAudit(_event: AuditEvent): void { /* no-op */ }
  recordPullRequest(_row: NewPullRequestRow): void { /* no-op */ }
  getAuditEvents(_sessionKey: string): AuditEvent[] { return []; }
  listOpenPullRequests(): PullRequestRow[] { return []; }
  listExpired(_cutoffMs: number): SessionRow[] { return []; }
  deleteSession(_key: string): void { /* no-op */ }
  close(): void { /* no-op */ }
  sumCostByTask(_sessionKey: string): number { return 0; }
  sumCostByUserSince(_userId: string, _sinceMs: number): number { return 0; }
  sumCostGlobalSince(_sinceMs: number): number { return 0; }
  hasExecOptIn(_teamId: string, _userId: string): boolean { return false; }
  recordExecOptIn(_teamId: string, _userId: string, _atMs: number): void { /* no-op */ }
}
