/**
 * Tests for SqliteSessionStore and the rehydrate-on-reply path in SessionManager.
 *
 * All SQLite access uses ':memory:' — no files on disk, no network.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SqliteSessionStore } from '../src/sessions/store.js';
import type { SessionStore } from '../src/sessions/store.js';
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

  it('recordSession with INSERT OR REPLACE is idempotent', () => {
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
    store.recordSession({ ...base, last_active_at: 2_000 });
    const row = store.get('DUP');
    // second insert wins (INSERT OR REPLACE)
    expect(row?.last_active_at).toBe(2_000);
  });

  it('touch is a no-op for unknown keys (does not throw)', () => {
    expect(() => store.touch('GHOST', 999)).not.toThrow();
  });

  it('setStatus is a no-op for unknown keys (does not throw)', () => {
    expect(() => store.setStatus('GHOST', 'reaped')).not.toThrow();
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
