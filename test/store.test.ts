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
import { FakeSlackClient } from '../src/slack/fake-slack-client.js';

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

  it('stores harness_version when set (0014 Part A attribution stamp)', () => {
    store.recordSession({
      session_key: 'T:C:VER',
      team_id: null,
      user_id: null,
      channel_id: 'C',
      thread_ts: 'TS',
      profile_id: 'conversational',
      harness_version: '7',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'active',
    });

    expect(store.get('T:C:VER')?.harness_version).toBe('7');
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
      profile_id: 'repo-oneshot',
      ts: 1_700_000_000_000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
};
    store.recordAudit(event);

    const rows = store.getAuditEvents('T:C:TS');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.session_key).toBe('T:C:TS');
    expect(row?.team_id).toBe('TEAM1');
    expect(row?.user_id).toBe('U1');
    expect(row?.profile_id).toBe('repo-oneshot');
    expect(row?.ts).toBe(1_700_000_000_000);
    expect(row?.kind).toBe('lifecycle');
    expect(row?.tool).toBe('session');
    expect(row?.summary).toBeNull();
    expect(row?.reasoning).toBeNull();
    expect(row?.result).toBe('created');
    expect(row?.cost_tokens).toBeNull();
    expect(row?.cost_micro_usd).toBeNull();
  });

  it('recordAudit + getAuditEvents round-trip stores protocol_skip kind correctly', () => {
    const event: AuditEvent = {
      session_key: 'T:C:PSKIP',
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 1_700_000_001_000,
      kind: 'protocol_skip',
      tool: null,
      summary: '42b',
      reasoning: null,
      result: 'json_parse',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: null,
    };
    store.recordAudit(event);

    const rows = store.getAuditEvents('T:C:PSKIP');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('protocol_skip');
    expect(rows[0]?.result).toBe('json_parse');
    expect(rows[0]?.summary).toBe('42b');
  });

  it('getAuditEvents returns empty array for unknown session key', () => {
    expect(store.getAuditEvents('NO:SUCH:KEY')).toHaveLength(0);
  });

  it('getAuditEvents returns only rows for the requested session_key', () => {
    store.recordAudit({
      session_key: 'K1',
      team_id: null,
      user_id: null,
      profile_id: null,
      ts: 1000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});
    store.recordAudit({
      session_key: 'K2',
      team_id: null,
      user_id: null,
      profile_id: null,
      ts: 2000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
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
      profile_id: null,
      summary: null,
      reasoning: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
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
      profile_id: 'repo-oneshot',
      ts: 9000,
      kind: 'action',
      tool: 'open-pr',
      summary: url,
      reasoning: null,
      result: 'opened',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});

    const rows = store.getAuditEvents('S:C:T');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('action');
    expect(rows[0]?.tool).toBe('open-pr');
    expect(rows[0]?.profile_id).toBe('repo-oneshot');
    expect(rows[0]?.summary).toBe(url);
    expect(rows[0]?.result).toBe('opened');
  });

  it('nullable fields are stored and retrieved as null', () => {
    store.recordAudit({
      session_key: 'NULL:TEST',
      team_id: null,
      user_id: null,
      profile_id: null,
      ts: 1,
      kind: 'approval',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});

    const rows = store.getAuditEvents('NULL:TEST');
    expect(rows[0]?.team_id).toBeNull();
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.profile_id).toBeNull();
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
      profile_id: 'supervised-repo-oneshot',
      ts: 1_700_000_001_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: 165,
      cost_micro_usd: 12300,
      durations_ms: null,
    graded_audit_id: null,
});

    const rows = store.getAuditEvents('COST:TEST');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('cost');
    expect(rows[0]?.cost_tokens).toBe(165);
    expect(rows[0]?.cost_micro_usd).toBe(12300);
    expect(rows[0]?.team_id).toBe('TEAM1');
    expect(rows[0]?.user_id).toBe('U1');
    expect(rows[0]?.profile_id).toBe('supervised-repo-oneshot');
    expect(rows[0]?.tool).toBeNull();
  });

  it('round-trips a kind:cost AuditEvent with cost_micro_usd = null', () => {
    store.recordAudit({
      session_key: 'COST:NULL',
      team_id: null,
      user_id: null,
      profile_id: null,
      ts: 2_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});

    const rows = store.getAuditEvents('COST:NULL');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('cost');
    expect(rows[0]?.cost_micro_usd).toBeNull();
  });

  it('round-trips a kind:decision AuditEvent with correlation summary and rationale', () => {
    store.recordAudit({
      session_key: 'DECISION:TEST',
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 3_000,
      kind: 'decision',
      tool: 'verify',
      summary: 'build-join-3',
      reasoning: 'The diff matched the spec and the checks ran green.',
      result: 'pass',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: null,
    });

    expect(store.getAuditEvents('DECISION:TEST')).toEqual([{
      session_key: 'DECISION:TEST',
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 3_000,
      kind: 'decision',
      tool: 'verify',
      summary: 'build-join-3',
      reasoning: 'The diff matched the spec and the checks ran green.',
      result: 'pass',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: null,
    }]);
  });

  it('round-trips a kind:comprehension AuditEvent with graded_audit_id link', () => {
    store.recordAudit({
      session_key: 'COMPREHENSION:TEST',
      team_id: 'TEAM1',
      user_id: null,
      profile_id: 'repo-oneshot',
      ts: 3_500,
      kind: 'comprehension',
      tool: 'comprehension',
      summary: null,
      reasoning: 'Does not explain rollback or cite the spec section.',
      result: 'thin',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: 42,
    });

    expect(store.getAuditEvents('COMPREHENSION:TEST')).toEqual([{
      session_key: 'COMPREHENSION:TEST',
      team_id: 'TEAM1',
      user_id: null,
      profile_id: 'repo-oneshot',
      ts: 3_500,
      kind: 'comprehension',
      tool: 'comprehension',
      summary: null,
      reasoning: 'Does not explain rollback or cite the spec section.',
      result: 'thin',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: 42,
    }]);
  });

  it('round-trips a kind:timing AuditEvent with durations_ms JSON', () => {
    store.recordAudit({
      session_key: 'TIMING:TEST',
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 4_000,
      kind: 'timing',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: '{"agentMs":1234,"spawnMs":800,"publishMs":300}',
      graded_audit_id: null,
    });

    expect(store.getAuditEvents('TIMING:TEST')).toEqual([{
      session_key: 'TIMING:TEST',
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 4_000,
      kind: 'timing',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: '{"agentMs":1234,"spawnMs":800,"publishMs":300}',
      graded_audit_id: null,
    }]);
  });
});

describe('SqliteSessionStore — listDecisionsToGrade', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function recordDecision(params: {
    sessionKey: string;
    ts: number;
    reasoning: string | null;
  }): void {
    store.recordAudit({
      session_key: params.sessionKey,
      team_id: 'TEAM1',
      user_id: 'U1',
      profile_id: 'repo-oneshot',
      ts: params.ts,
      kind: 'decision',
      tool: 'verify',
      summary: null,
      reasoning: params.reasoning,
      result: 'pass',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: null,
    });
  }

  it('returns only decision rows with reasoning and no existing comprehension row, honoring sinceMs and limit', () => {
    recordDecision({ sessionKey: 'DECISION:OLD', ts: 100, reasoning: 'old decision' });
    recordDecision({ sessionKey: 'DECISION:NOREASON', ts: 200, reasoning: null });
    recordDecision({ sessionKey: 'DECISION:GRADED', ts: 300, reasoning: 'already graded' });
    recordDecision({ sessionKey: 'DECISION:FRESH1', ts: 400, reasoning: 'fresh one' });
    recordDecision({ sessionKey: 'DECISION:FRESH2', ts: 500, reasoning: 'fresh two' });

    const initial = store.listDecisionsToGrade({});
    const graded = initial.find((row) => row.session_key === 'DECISION:GRADED');
    expect(graded).toBeDefined();

    store.recordAudit({
      session_key: 'DECISION:GRADED',
      team_id: 'TEAM1',
      user_id: null,
      profile_id: 'repo-oneshot',
      ts: 350,
      kind: 'comprehension',
      tool: 'comprehension',
      summary: null,
      reasoning: 'Previous advisory gaps.',
      result: 'thin',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: graded?.id ?? null,
    });

    expect(store.listDecisionsToGrade({})).toEqual([
      {
        id: initial.find((row) => row.session_key === 'DECISION:OLD')?.id ?? -1,
        session_key: 'DECISION:OLD',
        team_id: 'TEAM1',
        profile_id: 'repo-oneshot',
        tool: 'verify',
        result: 'pass',
        reasoning: 'old decision',
      },
      {
        id: initial.find((row) => row.session_key === 'DECISION:FRESH1')?.id ?? -1,
        session_key: 'DECISION:FRESH1',
        team_id: 'TEAM1',
        profile_id: 'repo-oneshot',
        tool: 'verify',
        result: 'pass',
        reasoning: 'fresh one',
      },
      {
        id: initial.find((row) => row.session_key === 'DECISION:FRESH2')?.id ?? -1,
        session_key: 'DECISION:FRESH2',
        team_id: 'TEAM1',
        profile_id: 'repo-oneshot',
        tool: 'verify',
        result: 'pass',
        reasoning: 'fresh two',
      },
    ]);

    expect(store.listDecisionsToGrade({ sinceMs: 350, limit: 1 })).toEqual([
      {
        id: initial.find((row) => row.session_key === 'DECISION:FRESH1')?.id ?? -1,
        session_key: 'DECISION:FRESH1',
        team_id: 'TEAM1',
        profile_id: 'repo-oneshot',
        tool: 'verify',
        result: 'pass',
        reasoning: 'fresh one',
      },
    ]);
  });
});

describe('SqliteSessionStore — pull_requests', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('recordPullRequest + listOpenPullRequests round-trips the stored row with SQL defaults', () => {
    store.recordPullRequest({
      session_key: 'TEAM:C:TS',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 42,
      head_sha: 'abc123def456',
      correlation_id: 'build-42',
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
    });

    const rows = store.listOpenPullRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      session_key: 'TEAM:C:TS',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 42,
      head_sha: 'abc123def456',
      correlation_id: 'build-42',
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
      state: 'open',
      last_polled_at: null,
      resolved_at: null,
    });
  });

  it('stores a null correlation_id when the publish path had no build correlation id', () => {
    store.recordPullRequest({
      session_key: 'TEAM:C:NULL',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 43,
      head_sha: 'def456abc123',
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_100,
    });

    expect(store.getPullRequest(1)?.correlation_id).toBeNull();
  });

  it('resolvePullRequest moves the row out of the open worklist and stamps terminal fields', () => {
    store.recordPullRequest({
      session_key: 'TEAM:C:TS',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 42,
      head_sha: 'abc123def456',
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
    });

    store.resolvePullRequest(1, 'merged_clean', 1_700_000_123_456);

    expect(store.listOpenPullRequests()).toEqual([]);
    expect(store.getPullRequest(1)).toEqual({
      id: 1,
      session_key: 'TEAM:C:TS',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 42,
      head_sha: 'abc123def456',
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
      state: 'merged_clean',
      last_polled_at: 1_700_000_123_456,
      resolved_at: 1_700_000_123_456,
    });
  });

  it('touchPullRequestPolled updates last_polled_at while the row stays open', () => {
    store.recordPullRequest({
      session_key: 'TEAM:C:TS',
      team_id: 'TEAM1',
      repo: 'owner/repo',
      pr_number: 42,
      head_sha: 'abc123def456',
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
    });

    store.touchPullRequestPolled(1, 1_700_000_111_222);

    expect(store.listOpenPullRequests()).toHaveLength(1);
    expect(store.getPullRequest(1)?.state).toBe('open');
    expect(store.getPullRequest(1)?.last_polled_at).toBe(1_700_000_111_222);
    expect(store.getPullRequest(1)?.resolved_at).toBeNull();
  });

  it('listOpenPullRequests returns never-polled rows before already-polled ones (oldest-polled first)', () => {
    const base = {
      team_id: 'TEAM1',
      repo: 'owner/repo',
      head_sha: 'sha',
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: 1_700_000_000_000,
    };
    store.recordPullRequest({ ...base, session_key: 'A', pr_number: 1 });
    store.recordPullRequest({ ...base, session_key: 'B', pr_number: 2 });
    store.recordPullRequest({ ...base, session_key: 'C', pr_number: 3 });
    // Poll #1 and #2 (give them last_polled_at); #3 stays never-polled (NULL).
    store.touchPullRequestPolled(1, 5_000);
    store.touchPullRequestPolled(2, 9_000);

    // Never-polled (#3, NULL) sorts first, then oldest last_polled_at (#1 before #2),
    // so the sweep drains the freshest-needed work first and starves nobody.
    expect(store.listOpenPullRequests().map((r) => r.pr_number)).toEqual([3, 1, 2]);
  });
});

describe('SqliteSessionStore — acceptance stats', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function recordTrackedPullRequest(params: {
    id: number;
    sessionKey: string;
    teamId: string | null;
    prNumber: number;
    openedAt: number;
    state?: 'open' | 'merged_clean' | 'merged_intervened' | 'closed' | 'stale';
  }): void {
    store.recordPullRequest({
      session_key: params.sessionKey,
      team_id: params.teamId,
      repo: 'owner/repo',
      pr_number: params.prNumber,
      head_sha: `sha-${params.prNumber}`,
      correlation_id: null,
      profile_id: 'repo-oneshot',
      opened_at: params.openedAt,
    });

    if (params.state !== undefined && params.state !== 'open') {
      store.resolvePullRequest(params.id, params.state, params.openedAt + 10);
    }
  }

  it('acceptanceStatsGlobalSince counts each state for PRs opened within the window', () => {
    const since = 1_700_000_100_000;

    recordTrackedPullRequest({ id: 1, sessionKey: 'TEAM1:1', teamId: 'TEAM1', prNumber: 1, openedAt: since, state: 'open' });
    recordTrackedPullRequest({ id: 2, sessionKey: 'TEAM1:2', teamId: 'TEAM1', prNumber: 2, openedAt: since + 1, state: 'merged_clean' });
    recordTrackedPullRequest({ id: 3, sessionKey: 'TEAM1:3', teamId: 'TEAM1', prNumber: 3, openedAt: since + 2, state: 'merged_intervened' });
    recordTrackedPullRequest({ id: 4, sessionKey: 'TEAM2:4', teamId: 'TEAM2', prNumber: 4, openedAt: since + 3, state: 'closed' });
    recordTrackedPullRequest({ id: 5, sessionKey: 'TEAM2:5', teamId: 'TEAM2', prNumber: 5, openedAt: since + 4, state: 'stale' });

    // Older PRs are outside the opened_at >= since window and must be excluded.
    recordTrackedPullRequest({ id: 6, sessionKey: 'TEAM1:6', teamId: 'TEAM1', prNumber: 6, openedAt: since - 1, state: 'merged_clean' });
    recordTrackedPullRequest({ id: 7, sessionKey: 'TEAM2:7', teamId: 'TEAM2', prNumber: 7, openedAt: since - 2, state: 'open' });

    expect(store.acceptanceStatsGlobalSince(since)).toEqual({
      opened: 5,
      mergedClean: 1,
      mergedIntervened: 1,
      closed: 1,
      stale: 1,
      stillOpen: 1,
      resolved: 4,
      acceptanceRate: 0.25,
    });
  });

  it('acceptanceRate is null when no PR opened in the window has resolved', () => {
    const since = 5_000;

    recordTrackedPullRequest({ id: 1, sessionKey: 'TEAM1:1', teamId: 'TEAM1', prNumber: 1, openedAt: since, state: 'open' });
    recordTrackedPullRequest({ id: 2, sessionKey: 'TEAM1:2', teamId: 'TEAM1', prNumber: 2, openedAt: since + 1, state: 'open' });
    recordTrackedPullRequest({ id: 3, sessionKey: 'TEAM1:3', teamId: 'TEAM1', prNumber: 3, openedAt: since - 1, state: 'merged_clean' });

    expect(store.acceptanceStatsGlobalSince(since)).toEqual({
      opened: 2,
      mergedClean: 0,
      mergedIntervened: 0,
      closed: 0,
      stale: 0,
      stillOpen: 2,
      resolved: 0,
      acceptanceRate: null,
    });
  });

  it('acceptanceStatsByTeamSince isolates one team', () => {
    const since = 10_000;

    recordTrackedPullRequest({ id: 1, sessionKey: 'TEAM1:1', teamId: 'TEAM1', prNumber: 1, openedAt: since, state: 'merged_clean' });
    recordTrackedPullRequest({ id: 2, sessionKey: 'TEAM1:2', teamId: 'TEAM1', prNumber: 2, openedAt: since + 1, state: 'closed' });
    recordTrackedPullRequest({ id: 3, sessionKey: 'TEAM1:3', teamId: 'TEAM1', prNumber: 3, openedAt: since + 2, state: 'open' });
    recordTrackedPullRequest({ id: 4, sessionKey: 'TEAM2:4', teamId: 'TEAM2', prNumber: 4, openedAt: since + 3, state: 'merged_intervened' });
    recordTrackedPullRequest({ id: 5, sessionKey: 'TEAM2:5', teamId: 'TEAM2', prNumber: 5, openedAt: since + 4, state: 'stale' });
    recordTrackedPullRequest({ id: 6, sessionKey: 'NULLTEAM:6', teamId: null, prNumber: 6, openedAt: since + 5, state: 'merged_clean' });

    expect(store.acceptanceStatsByTeamSince('TEAM1', since)).toEqual({
      opened: 3,
      mergedClean: 1,
      mergedIntervened: 0,
      closed: 1,
      stale: 0,
      stillOpen: 1,
      resolved: 2,
      acceptanceRate: 0.5,
    });
  });

  it('counts an unexpected state toward opened only and does not throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-store-acceptance-'));
    const dbPath = path.join(tmpDir, 'test.db');
    let fileStore: SqliteSessionStore | undefined;

    try {
      fileStore = new SqliteSessionStore(dbPath);
      fileStore.recordPullRequest({
        session_key: 'TEAM1:1',
        team_id: 'TEAM1',
        repo: 'owner/repo',
        pr_number: 1,
        head_sha: 'sha-1',
        correlation_id: null,
        profile_id: 'repo-oneshot',
        opened_at: 20_000,
      });
      fileStore.recordPullRequest({
        session_key: 'TEAM1:2',
        team_id: 'TEAM1',
        repo: 'owner/repo',
        pr_number: 2,
        head_sha: 'sha-2',
        correlation_id: null,
        profile_id: 'repo-oneshot',
        opened_at: 20_001,
      });
      fileStore.resolvePullRequest(2, 'merged_clean', 20_010);

      const rawDb = new Database(dbPath);
      rawDb.prepare('UPDATE pull_requests SET state = ? WHERE id = ?').run('future_state', 1);
      rawDb.close();

      const stats = fileStore.acceptanceStatsGlobalSince(20_000);
      expect(stats).toEqual({
        opened: 2,
        mergedClean: 1,
        mergedIntervened: 0,
        closed: 0,
        stale: 0,
        stillOpen: 0,
        resolved: 1,
        acceptanceRate: 1,
      });
    } finally {
      fileStore?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      profile_id: null,
      ts: 1_000,
      kind: 'lifecycle',
      tool: null,
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});
    store1.close();

    // Open a fresh store on the same file — rows must still be there.
    const store2 = new SqliteSessionStore(dbPath);
    const rows = store2.getAuditEvents('DURABLE:K');
    store2.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('created');
    expect(rows[0]?.profile_id).toBeNull();
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
      profile_id: null,
      ts: 1_000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: 100,
      cost_micro_usd: 5_000,
      durations_ms: null,
    graded_audit_id: null,
});

    const allRows = store.getAuditEvents('OLD:K');
    store.close();

    expect(allRows).toHaveLength(2);
    const costRow = allRows.find((r) => r.kind === 'cost');
    expect(costRow?.cost_micro_usd).toBe(5_000);
  });

  it('migrates an 11-column audit_events table (pre-profile_id) and preserves existing rows', () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE audit_events (
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
      INSERT INTO audit_events (
        session_key, team_id, user_id, ts, kind, tool, summary, reasoning, result, cost_tokens, cost_micro_usd
      )
      VALUES ('OLD:PROFILE', 'T1', 'U1', 700, 'lifecycle', 'session', null, null, 'created', 42, 9_000);
    `);
    rawDb.close();

    const store = new SqliteSessionStore(dbPath);

    const rows = store.getAuditEvents('OLD:PROFILE');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_key).toBe('OLD:PROFILE');
    expect(rows[0]?.cost_micro_usd).toBe(9000);
    expect(rows[0]?.profile_id).toBeNull();

    store.recordAudit({
      session_key: 'OLD:PROFILE',
      team_id: 'T1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 1_500,
      kind: 'action',
      tool: 'open-pr',
      summary: 'https://github.com/acme/widgets/pull/9',
      reasoning: null,
      result: 'opened',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});

    const allRows = store.getAuditEvents('OLD:PROFILE');
    store.close();

    expect(allRows).toHaveLength(2);
    const newRow = allRows.find((row) => row.result === 'opened');
    expect(newRow?.profile_id).toBe('conversational');
  });

  it('migrates a 12-column audit_events table without durations_ms and preserves existing rows', () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE audit_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key    TEXT    NOT NULL,
        team_id        TEXT,
        user_id        TEXT,
        profile_id     TEXT,
        ts             INTEGER NOT NULL,
        kind           TEXT    NOT NULL,
        tool           TEXT,
        summary        TEXT,
        reasoning      TEXT,
        result         TEXT,
        cost_tokens    INTEGER,
        cost_micro_usd INTEGER
      );
      INSERT INTO audit_events (
        session_key, team_id, user_id, profile_id, ts, kind, tool, summary, reasoning, result, cost_tokens, cost_micro_usd
      )
      VALUES ('OLD:TIMING', 'T1', 'U1', 'conversational', 900, 'lifecycle', 'session', null, null, 'created', null, null);
    `);
    rawDb.close();

    const store = new SqliteSessionStore(dbPath);

    const migrated = store.getAuditEvents('OLD:TIMING');
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.durations_ms).toBeNull();

    store.recordAudit({
      session_key: 'OLD:TIMING',
      team_id: 'T1',
      user_id: 'U1',
      profile_id: 'conversational',
      ts: 1_000,
      kind: 'timing',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: '{"agentMs":55,"spawnMs":20}',
      graded_audit_id: null,
    });

    const rows = store.getAuditEvents('OLD:TIMING');
    store.close();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.durations_ms)).toEqual([null, '{"agentMs":55,"spawnMs":20}']);
  });

  it('migrates a 13-column audit_events table without graded_audit_id and preserves existing rows', () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE audit_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key    TEXT    NOT NULL,
        team_id        TEXT,
        user_id        TEXT,
        profile_id     TEXT,
        ts             INTEGER NOT NULL,
        kind           TEXT    NOT NULL,
        tool           TEXT,
        summary        TEXT,
        reasoning      TEXT,
        result         TEXT,
        cost_tokens    INTEGER,
        cost_micro_usd INTEGER,
        durations_ms   TEXT
      );
      INSERT INTO audit_events (
        session_key, team_id, user_id, profile_id, ts, kind, tool, summary, reasoning, result, cost_tokens, cost_micro_usd, durations_ms
      )
      VALUES ('OLD:COMP', 'T1', 'U1', 'repo-oneshot', 950, 'decision', 'verify', null, 'captured rationale', 'pass', null, null, null);
    `);
    rawDb.close();

    const store = new SqliteSessionStore(dbPath);

    const migrated = store.getAuditEvents('OLD:COMP');
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.graded_audit_id).toBeNull();

    const [decision] = store.listDecisionsToGrade({});
    expect(decision?.session_key).toBe('OLD:COMP');

    store.recordAudit({
      session_key: 'OLD:COMP',
      team_id: 'T1',
      user_id: null,
      profile_id: 'repo-oneshot',
      ts: 1_000,
      kind: 'comprehension',
      tool: 'comprehension',
      summary: null,
      reasoning: 'Needs clearer failure-mode coverage.',
      result: 'thin',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: decision?.id ?? null,
    });

    const rows = store.getAuditEvents('OLD:COMP');
    store.close();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.graded_audit_id)).toEqual([null, decision?.id ?? null]);
  });

  it('migrates a pull_requests table without correlation_id and preserves existing rows', () => {
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE pull_requests (
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
      INSERT INTO pull_requests (
        session_key, team_id, repo, pr_number, head_sha, profile_id, opened_at, state, last_polled_at, resolved_at
      )
      VALUES ('TEAM:C:OLDPR', 'TEAM', 'owner/repo', 1, 'old-sha', 'repo-oneshot', 700, 'open', null, null);
    `);
    rawDb.close();

    const store = new SqliteSessionStore(dbPath);

    const migrated = store.listOpenPullRequests();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.correlation_id).toBeNull();

    store.recordPullRequest({
      session_key: 'TEAM:C:NEWPR',
      team_id: 'TEAM',
      repo: 'owner/repo',
      pr_number: 2,
      head_sha: 'new-sha',
      correlation_id: 'build-new-2',
      profile_id: 'repo-oneshot',
      opened_at: 800,
    });

    const rows = store.listOpenPullRequests();
    store.close();

    expect(rows.map((row) => row.correlation_id)).toEqual([null, 'build-new-2']);
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
      profile_id: null,
      ts: 200,
      kind: 'lifecycle',
      tool: null,
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
});

    const rows = store.getAuditEvents('POST:PLACEHOLDER');
    store.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('created');
  });

  it('creates audit_by_user_ts, audit_by_ts, and audit_by_graded_audit_id indexes after open', () => {
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
    expect(indexNames).toContain('audit_by_graded_audit_id');
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
    profile_id: null as null,
    kind: 'cost' as const,
    tool: null as null,
    summary: null as null,
    reasoning: null as null,
    result: null as null,
    cost_tokens: null as null,
    durations_ms: null as null,
    graded_audit_id: null as null,
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
      profile_id: null,
      ts: 1000,
      kind: 'lifecycle',
      tool: 'session',
      summary: null,
      reasoning: null,
      result: 'created',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
    graded_audit_id: null,
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
    await manager.enqueueNew(key, {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      profileId: 'repo-oneshot',
    });
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

// ─── replaceExecOptIns reconcile semantics ────────────────────────────────────

describe('SqliteSessionStore — replaceExecOptIns', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('starts empty: hasExecOptIn is false for any pair', () => {
    expect(store.hasExecOptIn('T', 'U1')).toBe(false);
  });

  it('replaceExecOptIns([{T,U1},{T,U2}]) grants both', () => {
    store.replaceExecOptIns([{ teamId: 'T', userId: 'U1' }, { teamId: 'T', userId: 'U2' }], 1000);
    expect(store.hasExecOptIn('T', 'U1')).toBe(true);
    expect(store.hasExecOptIn('T', 'U2')).toBe(true);
  });

  it('second replace grants new + revokes old in a single atomic call', () => {
    store.replaceExecOptIns([{ teamId: 'T', userId: 'U1' }, { teamId: 'T', userId: 'U2' }], 1000);
    store.replaceExecOptIns([{ teamId: 'T', userId: 'U2' }, { teamId: 'T', userId: 'U3' }], 2000);

    expect(store.hasExecOptIn('T', 'U1')).toBe(false); // revoked
    expect(store.hasExecOptIn('T', 'U2')).toBe(true);  // still granted
    expect(store.hasExecOptIn('T', 'U3')).toBe(true);  // newly granted
  });

  it('replaceExecOptIns([]) revokes everyone', () => {
    store.replaceExecOptIns([{ teamId: 'T', userId: 'U1' }, { teamId: 'T', userId: 'U2' }], 1000);
    store.replaceExecOptIns([], 2000);

    expect(store.hasExecOptIn('T', 'U1')).toBe(false);
    expect(store.hasExecOptIn('T', 'U2')).toBe(false);
  });
});
