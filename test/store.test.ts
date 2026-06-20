/**
 * Tests for SqliteSessionStore and the rehydrate-on-reply path in SessionManager.
 *
 * Most SQLite access uses ':memory:' — no files on disk, no network. The durability
 * and migration tests deliberately use a real temp-file DB (via fs.mkdtempSync under
 * os.tmpdir()) so that two independent SqliteSessionStore connections share state and
 * prove rows survive a restart. Those tests clean up in afterEach.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteSessionStore } from '../src/sessions/store.js';
import type { SessionStore, AuditEvent } from '../src/sessions/store.js';
import { SessionManager } from '../src/sessions/manager.js';
import { FakeRunnerFactory } from '../src/runner/fake.js';
import { FakeSlackClient } from './responder.test.js';

// ─── SqliteSessionStore unit tests ───────────────────────────────────────────

describe('SqliteSessionStore', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('schema is created idempotently (two opens against :memory: each start fresh)', () => {
    // Just opening a second store must not throw
    const store2 = new SqliteSessionStore(':memory:');
    store2.close();
  });

  it('recordSession → get round-trip returns the stored row', () => {
    store.recordSession({
      session_key: 'T:C:TS',
      team_id: 'TEAM1',
      user_id: 'U1',
      channel_id: 'C1',
      thread_ts: 'TS1',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active',
    });

    const row = store.get('T:C:TS');
    expect(row).toBeDefined();
    expect(row?.session_key).toBe('T:C:TS');
    expect(row?.team_id).toBe('TEAM1');
    expect(row?.user_id).toBe('U1');
    expect(row?.channel_id).toBe('C1');
    expect(row?.thread_ts).toBe('TS1');
    expect(row?.profile_id).toBe('conversational');
    expect(row?.created_at).toBe(1_000);
    expect(row?.last_active_at).toBe(1_000);
    expect(row?.status).toBe('active');
    // Nullable columns not set in this slice
    expect(row?.sdk_session_id).toBeNull();
    expect(row?.harness_version).toBeNull();
    expect(row?.volume_name).toBeNull();
  });

  it('get returns undefined for an unknown key', () => {
    expect(store.get('MISSING:KEY')).toBeUndefined();
  });

  it('touch updates last_active_at', () => {
    store.recordSession({
      session_key: 'K',
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active',
    });

    store.touch('K', 5_000);

    const row = store.get('K');
    expect(row?.last_active_at).toBe(5_000);
    // created_at unchanged
    expect(row?.created_at).toBe(1_000);
  });

  it('setStatus updates status to reaped', () => {
    store.recordSession({
      session_key: 'K2',
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active',
    });

    store.setStatus('K2', 'reaped');

    const row = store.get('K2');
    expect(row?.status).toBe('reaped');
  });

  it('recordSession upsert updates last_active_at and status but preserves created_at', () => {
    const base = {
      session_key: 'DUP',
      team_id: 'T',
      user_id: 'U',
      channel_id: 'C',
      thread_ts: 'TS',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active' as const,
    };
    store.recordSession(base);

    // Simulate re-activation: a second recordSession for the same key
    // (e.g. after idle reap and rehydration).
    store.recordSession({ ...base, created_at: 9_999, last_active_at: 2_000 });

    const row = store.get('DUP');
    // last_active_at must reflect the second call
    expect(row?.last_active_at).toBe(2_000);
    // created_at must NOT be overwritten — original value is preserved
    expect(row?.created_at).toBe(1_000);
    // status is reset to active
    expect(row?.status).toBe('active');
  });

  it('touch is a no-op for unknown keys (does not throw)', () => {
    expect(() => store.touch('GHOST', 999)).not.toThrow();
  });

  it('setStatus is a no-op for unknown keys (does not throw)', () => {
    expect(() => store.setStatus('GHOST', 'reaped')).not.toThrow();
  });

  it('listExpired returns only rows strictly older than the cutoff', () => {
    // Insert three rows with explicit last_active_at values
    const base = {
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'conversational',
      created_at: 1_000,
      status: 'active' as const,
    };
    store.recordSession({ ...base, session_key: 'OLD1', last_active_at: 1_000 });
    store.recordSession({ ...base, session_key: 'OLD2', last_active_at: 2_000 });
    store.recordSession({ ...base, session_key: 'FRESH', last_active_at: 5_000 });

    // Cutoff = 3_000: rows with last_active_at < 3_000 → OLD1, OLD2
    const expired = store.listExpired(3_000);
    const keys = expired.map((r) => r.session_key);
    expect(keys).toContain('OLD1');
    expect(keys).toContain('OLD2');
    expect(keys).not.toContain('FRESH');
  });

  it('listExpired boundary: row equal to cutoff is NOT returned (strictly older)', () => {
    store.recordSession({
      session_key: 'BOUNDARY',
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'conversational',
      created_at: 3_000,
      last_active_at: 3_000,
      status: 'active',
    });

    // cutoff = 3_000: last_active_at = 3_000 is NOT strictly less than 3_000
    const expired = store.listExpired(3_000);
    expect(expired.map((r) => r.session_key)).not.toContain('BOUNDARY');
  });

  it('deleteSession removes the row (get returns undefined after)', () => {
    store.recordSession({
      session_key: 'TO_DEL',
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active',
    });

    expect(store.get('TO_DEL')).toBeDefined();
    store.deleteSession('TO_DEL');
    expect(store.get('TO_DEL')).toBeUndefined();
  });

  it('deleteSession is a no-op for unknown keys (does not throw)', () => {
    expect(() => store.deleteSession('GHOST_DEL')).not.toThrow();
  });
});

// ─── SqliteSessionStore — audit_events round-trip ────────────────────────────

describe('SqliteSessionStore — audit_events', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('recordAudit + getAuditEvents round-trip stores all fields correctly', () => {
    const event: AuditEvent = {
      session_key: 'T:C:TS',
      team_id: 'TEAM1',
      user_id: 'U1',
      ts: 1_700_000_000_000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    };
    store.recordAudit(event);

    const rows = store.getAuditEvents('T:C:TS');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.session_key).toBe('T:C:TS');
    expect(row?.team_id).toBe('TEAM1');
    expect(row?.user_id).toBe('U1');
    expect(row?.ts).toBe(1_700_000_000_000);
    expect(row?.kind).toBe('lifecycle');
    expect(row?.tool).toBe('session');
    expect(row?.summary).toBeNull();
    expect(row?.reasoning).toBeNull();
    expect(row?.result).toBe('created');
    expect(row?.cost_tokens).toBeNull();
    expect(row?.cost_micro_usd).toBeNull();
  });

  it('getAuditEvents returns empty array for unknown session key', () => {
    expect(store.getAuditEvents('NO:SUCH:KEY')).toHaveLength(0);
  });

  it('getAuditEvents returns only rows for the requested session_key', () => {
    store.recordAudit({
      session_key: 'K1',
      team_id: null,
      user_id: null,
      ts: 1000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    });
    store.recordAudit({
      session_key: 'K2',
      team_id: null,
      user_id: null,
      ts: 2000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    });

    expect(store.getAuditEvents('K1')).toHaveLength(1);
    expect(store.getAuditEvents('K2')).toHaveLength(1);
    expect(store.getAuditEvents('K1')[0]?.ts).toBe(1000);
  });

  it('multiple events for the same session are returned in insertion order', () => {
    const base = {
      session_key: 'SEQ',
      team_id: null,
      user_id: null,
      summary: null,
      reasoning: null,
      cost_tokens: null,
      cost_micro_usd: null,
    };
    store.recordAudit({ ...base, ts: 100, kind: 'lifecycle', tool: 'session', result: 'created' });
    store.recordAudit({ ...base, ts: 200, kind: 'approval', tool: 'plan-gate', result: 'requested' });
    store.recordAudit({ ...base, ts: 300, kind: 'lifecycle', tool: 'session', result: 'reaped' });

    const rows = store.getAuditEvents('SEQ');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.result).toBe('created');
    expect(rows[1]?.result).toBe('requested');
    expect(rows[2]?.result).toBe('reaped');
  });

  it('stores a pr_opened event with summary = url (URL is metadata, not message content)', () => {
    const url = 'https://github.com/acme/widgets/pull/42';
    store.recordAudit({
      session_key: 'S:C:T',
      team_id: 'T1',
      user_id: 'U1',
      ts: 9000,
      kind: 'action',
      tool: 'open-pr',
      summary: url,
      reasoning: null,
      result: 'opened',
      cost_tokens: null,
      cost_micro_usd: null,
    });

    const rows = store.getAuditEvents('S:C:T');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('action');
    expect(rows[0]?.tool).toBe('open-pr');
    expect(rows[0]?.summary).toBe(url);
    expect(rows[0]?.result).toBe('opened');
  });

  it('nullable fields are stored and retrieved as null', () => {
    store.recordAudit({
      session_key: 'NULL:TEST',
      team_id: null,
      user_id: null,
      ts: 1,
      kind: 'approval',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
    });

    const rows = store.getAuditEvents('NULL:TEST');
    expect(rows[0]?.team_id).toBeNull();
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.tool).toBeNull();
    expect(rows[0]?.summary).toBeNull();
    expect(rows[0]?.reasoning).toBeNull();
    expect(rows[0]?.result).toBeNull();
    expect(rows[0]?.cost_tokens).toBeNull();
    expect(rows[0]?.cost_micro_usd).toBeNull();
  });

  it('round-trips a kind:cost AuditEvent with cost_micro_usd value', () => {
    store.recordAudit({
      session_key: 'COST:TEST',
      team_id: 'TEAM1',
      user_id: 'U1',
      ts: 1_700_000_001_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: 165,
      cost_micro_usd: 12300,
    });

    const rows = store.getAuditEvents('COST:TEST');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('cost');
    expect(rows[0]?.cost_tokens).toBe(165);
    expect(rows[0]?.cost_micro_usd).toBe(12300);
    expect(rows[0]?.team_id).toBe('TEAM1');
    expect(rows[0]?.user_id).toBe('U1');
    expect(rows[0]?.tool).toBeNull();
  });

  it('round-trips a kind:cost AuditEvent with cost_micro_usd = null', () => {
    store.recordAudit({
      session_key: 'COST:NULL',
      team_id: null,
      user_id: null,
      ts: 2_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
    });

    const rows = store.getAuditEvents('COST:NULL');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('cost');
    expect(rows[0]?.cost_micro_usd).toBeNull();
  });
});

// ─── SqliteSessionStore — durability, migration, and indexes ─────────────────
// These tests use a real temp-file DB so two connections share the same underlying
// file, proving that rows survive a store close/reopen cycle.

describe('SqliteSessionStore — durability', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-store-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    // Best-effort cleanup of the temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('audit rows survive a store close + reopen (no DROP on second open)', () => {
    const store1 = new SqliteSessionStore(dbPath);
    store1.recordAudit({
      session_key: 'DURABLE:K',
      team_id: null,
      user_id: null,
      ts: 1_000,
      kind: 'lifecycle',
      tool: null,
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    });
    store1.close();

    // Open a fresh store on the same file — rows must still be there.
    const store2 = new SqliteSessionStore(dbPath);
    const rows = store2.getAuditEvents('DURABLE:K');
    store2.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('created');
  });

  it('migrates a 10-column audit_events table (pre-cost_micro_usd) and preserves existing rows', () => {
    // Directly create the old 10-column table — no cost_micro_usd column.
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE audit_events (
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
        cost_tokens  INTEGER
      );
      INSERT INTO audit_events (session_key, team_id, user_id, ts, kind, tool, summary, reasoning, result, cost_tokens)
      VALUES ('OLD:K', 'T1', 'U1', 500, 'lifecycle', null, null, null, 'created', 42);
    `);
    rawDb.close();

    // Open via SqliteSessionStore — should migrate and preserve the old row.
    const store = new SqliteSessionStore(dbPath);

    // Old row is preserved and readable; cost_micro_usd is null (it had no value).
    const rows = store.getAuditEvents('OLD:K');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_key).toBe('OLD:K');
    expect(rows[0]?.cost_tokens).toBe(42);
    expect(rows[0]?.cost_micro_usd).toBeNull();

    // New kind:'cost' write with cost_micro_usd round-trips correctly.
    store.recordAudit({
      session_key: 'OLD:K',
      team_id: null,
      user_id: null,
      ts: 1_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: 100,
      cost_micro_usd: 5_000,
    });

    const allRows = store.getAuditEvents('OLD:K');
    store.close();

    expect(allRows).toHaveLength(2);
    const costRow = allRows.find((r) => r.kind === 'cost');
    expect(costRow?.cost_micro_usd).toBe(5_000);
  });

  it('replaces pre-S05 placeholder shape (event_type/payload, no session_key) and works normally after', () => {
    // Simulate the old placeholder table.
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE audit_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type  TEXT NOT NULL,
        payload     TEXT
      );
    `);
    rawDb.close();

    // Open via SqliteSessionStore — the placeholder table should be replaced.
    const store = new SqliteSessionStore(dbPath);

    // Normal audit write must work after the replacement.
    store.recordAudit({
      session_key: 'POST:PLACEHOLDER',
      team_id: null,
      user_id: null,
      ts: 200,
      kind: 'lifecycle',
      tool: null,
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    });

    const rows = store.getAuditEvents('POST:PLACEHOLDER');
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('created');
  });

  it('creates audit_by_user_ts and audit_by_ts indexes after open', () => {
    const store = new SqliteSessionStore(dbPath);

    // Query sqlite_master for index names on audit_events.
    const rawDb = new Database(dbPath);
    const indexRows = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'",
    ).all() as Array<{ name: string }>;
    rawDb.close();
    store.close();

    const indexNames = indexRows.map((r) => r.name);
    expect(indexNames).toContain('audit_by_user_ts');
    expect(indexNames).toContain('audit_by_ts');
  });
});

// ─── SqliteSessionStore — SUM cap methods (Slice B1) ─────────────────────────

describe('SqliteSessionStore — sumCostByTask / sumCostByUserSince / sumCostGlobalSince', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const baseEvent = {
    team_id: null as null,
    user_id: null as null,
    kind: 'cost' as const,
    tool: null as null,
    summary: null as null,
    reasoning: null as null,
    result: null as null,
    cost_tokens: null as null,
  };

  it('sumCostByTask returns 0 when no rows exist for the session', () => {
    expect(store.sumCostByTask('NO:SUCH:KEY')).toBe(0);
  });

  it('sumCostByUserSince returns 0 when no rows exist', () => {
    expect(store.sumCostByUserSince('U1', 0)).toBe(0);
  });

  it('sumCostGlobalSince returns 0 when no rows exist', () => {
    expect(store.sumCostGlobalSince(0)).toBe(0);
  });

  it('sumCostByTask sums only the matching session_key', () => {
    store.recordAudit({ ...baseEvent, session_key: 'K1', ts: 1000, cost_micro_usd: 3000 });
    store.recordAudit({ ...baseEvent, session_key: 'K1', ts: 2000, cost_micro_usd: 7000 });
    store.recordAudit({ ...baseEvent, session_key: 'K2', ts: 3000, cost_micro_usd: 50000 });

    expect(store.sumCostByTask('K1')).toBe(10000);
    expect(store.sumCostByTask('K2')).toBe(50000);
    expect(store.sumCostByTask('K3')).toBe(0);
  });

  it('sumCostByTask ignores null cost_micro_usd rows', () => {
    store.recordAudit({ ...baseEvent, session_key: 'K1', ts: 1000, cost_micro_usd: 5000 });
    store.recordAudit({ ...baseEvent, session_key: 'K1', ts: 2000, cost_micro_usd: null });

    expect(store.sumCostByTask('K1')).toBe(5000);
  });

  it('sumCostByUserSince sums only rows with matching user_id within the window', () => {
    const since = 5000;
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since + 1, cost_micro_usd: 2000 });
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since + 2, cost_micro_usd: 3000 });
    // exactly at since — should be excluded (ts > since, not >=)
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since, cost_micro_usd: 1000 });
    // different user — excluded
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U2', ts: since + 3, cost_micro_usd: 99999 });

    expect(store.sumCostByUserSince('U1', since)).toBe(5000);
    expect(store.sumCostByUserSince('U2', since)).toBe(99999);
  });

  it('sumCostByUserSince excludes rows older than the window (boundary row at exactly since is excluded)', () => {
    const since = 10_000;
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since - 1, cost_micro_usd: 9000 });
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since, cost_micro_usd: 5000 });

    // Both are <= since, so excluded by ts > since
    expect(store.sumCostByUserSince('U1', since)).toBe(0);
  });

  it('sumCostGlobalSince sums all rows with ts > sinceMs regardless of user or session', () => {
    const since = 5000;
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since + 1, cost_micro_usd: 1000 });
    store.recordAudit({ ...baseEvent, session_key: 'K2', user_id: 'U2', ts: since + 2, cost_micro_usd: 2000 });
    store.recordAudit({ ...baseEvent, session_key: 'K3', user_id: null, ts: since + 3, cost_micro_usd: 3000 });
    // old row — excluded
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: since - 1, cost_micro_usd: 9999 });

    expect(store.sumCostGlobalSince(since)).toBe(6000);
  });

  it('sumCostGlobalSince excludes the boundary row (ts > since, not >=)', () => {
    const since = 8000;
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: null, ts: since, cost_micro_usd: 5000 });

    expect(store.sumCostGlobalSince(since)).toBe(0);
  });

  it('kind != cost rows with null cost_micro_usd do not affect SUM (COALESCE SUM trick)', () => {
    store.recordAudit({
      session_key: 'K1',
      team_id: null,
      user_id: 'U1',
      ts: 1000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
    });
    store.recordAudit({ ...baseEvent, session_key: 'K1', user_id: 'U1', ts: 2000, cost_micro_usd: 500 });

    expect(store.sumCostByTask('K1')).toBe(500);
    expect(store.sumCostByUserSince('U1', 0)).toBe(500);
    expect(store.sumCostGlobalSince(0)).toBe(500);
  });
});

// ─── Rehydrate-on-reply integration tests ────────────────────────────────────

/**
 * A thin SessionStore fake backed by a real in-memory SQLite so we can
 * pre-seed rows without relying on SessionManager.
 */
function makeRehydrateSetup(idleTimeoutMs = 60_000) {
  const slack = new FakeSlackClient();
  const factory = new FakeRunnerFactory();
  const store: SessionStore = new SqliteSessionStore(':memory:');
  const manager = new SessionManager({ idleTimeoutMs, factory, slack, store });
  return { manager, factory, slack, store };
}

describe('SessionManager — rehydrate-on-reply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('after idle eviction, a thread reply with a store row recreates the session and drains the message', async () => {
    const TIMEOUT = 5_000;
    const { manager, factory } = makeRehydrateSetup(TIMEOUT);
    const key = 'TEAM:C:T';

    // 1. Create the session via enqueueNew (writes store row + creates runner #1).
    await manager.enqueueNew(key, { message: 'hello', channel: 'C', threadTs: 'T', teamId: 'TEAM' });
    // Flush microtasks so the drain loop completes and resets the idle timer.
    await vi.advanceTimersByTimeAsync(0);

    expect(factory.creates).toHaveLength(1);
    expect(manager.has(key)).toBe(true);

    // 2. Simulate idle eviction by advancing past the timeout.
    await vi.advanceTimersByTimeAsync(TIMEOUT + 100);
    expect(manager.has(key)).toBe(false);
    expect(factory.runners[0]?.disposed).toBe(true);

    // 3. Thread reply arrives — session is gone from memory but store has the row.
    const routed = await manager.enqueueExisting(key, {
      message: 'reply after restart',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
    });

    // Should have accepted the message.
    expect(routed).toBe(true);

    // A second factory.create call means the session was rehydrated.
    expect(factory.creates).toHaveLength(2);
    expect(factory.creates[1]).toBe(key);

    // Session is now back in memory.
    expect(manager.has(key)).toBe(true);

    // Flush drain so runner #2 processes the message.
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.runners[1]?.sends).toContain('reply after restart');
  });

  it('a truly-unknown thread (no store row, no memory) is ignored', async () => {
    const { manager, factory } = makeRehydrateSetup();

    const routed = await manager.enqueueExisting('UNKNOWN:C:T', {
      message: 'hello?',
      channel: 'C',
      threadTs: 'T',
    });

    expect(routed).toBe(false);
    expect(factory.creates).toHaveLength(0);
    expect(manager.has('UNKNOWN:C:T')).toBe(false);
  });

  it('the normal in-memory-hit path is not changed by the store', async () => {
    const { manager, factory } = makeRehydrateSetup();
    const key = 'TEAM:C:T2';

    // Create session.
    await manager.enqueueNew(key, { message: 'first', channel: 'C', threadTs: 'T2', teamId: 'TEAM' });
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.creates).toHaveLength(1);

    // Enqueue to the still-live session — no new create.
    const routed = await manager.enqueueExisting(key, {
      message: 'second',
      channel: 'C',
      threadTs: 'T2',
    });

    expect(routed).toBe(true);
    // Still only one factory.create — used the in-memory session.
    expect(factory.creates).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(factory.runners[0]?.sends).toContain('second');
  });
});
