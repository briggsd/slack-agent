/**
 * SessionStore — persisted index of gateway sessions.
 *
 * Schema from design/0002 §2. Columns the gateway doesn't yet populate
 * (sdk_session_id, harness_version, volume_name) are left nullable and
 * unset in this slice — they're wired up in later milestones.
 *
 * The audit_events table is created here (M6 will write rows to it).
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
  | 'created_at'
  | 'last_active_at'
  | 'status'
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
  /** Close the underlying database handle. */
  close(): void;
}

// ─── SQLite implementation ────────────────────────────────────────────────────

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
  }

  private createSchema(): void {
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

      CREATE TABLE IF NOT EXISTS audit_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key  TEXT    NOT NULL,
        event_type   TEXT    NOT NULL,
        payload      TEXT,
        created_at   INTEGER NOT NULL
      );
    `);
  }

  recordSession(row: NewSessionRow): void {
    const stmt = this.db.prepare<[
      string,
      string | null,
      string | null,
      string,
      string,
      string,
      number,
      number,
      string,
    ]>(`
      INSERT OR REPLACE INTO sessions
        (session_key, team_id, user_id, channel_id, thread_ts, profile_id,
         created_at, last_active_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.session_key,
      row.team_id,
      row.user_id,
      row.channel_id,
      row.thread_ts,
      row.profile_id,
      row.created_at,
      row.last_active_at,
      row.status,
    );
  }

  touch(key: string, atMs: number): void {
    const stmt = this.db.prepare<[number, string]>(
      'UPDATE sessions SET last_active_at = ? WHERE session_key = ?',
    );
    stmt.run(atMs, key);
  }

  setStatus(key: string, status: SessionStatus): void {
    const stmt = this.db.prepare<[string, string]>(
      'UPDATE sessions SET status = ? WHERE session_key = ?',
    );
    stmt.run(status, key);
  }

  get(key: string): SessionRow | undefined {
    const stmt = this.db.prepare<[string], SessionRow>(
      'SELECT * FROM sessions WHERE session_key = ?',
    );
    return stmt.get(key);
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
  close(): void { /* no-op */ }
}
