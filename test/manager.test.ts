import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/sessions/manager.js';
import { FakeRunnerFactory, FakeRunner } from '../src/runner/fake.js';
import type { TurnScript } from '../src/runner/fake.js';
import type {
  RunnerEvent,
  RunnerStream,
  SessionRunner,
  RunnerFactory,
  GateResume,
  VolumeReaper,
} from '../src/runner/types.js';
import type { Profile } from '../src/profiles/registry.js';
import type {
  SessionStore,
  SessionRow,
  NewSessionRow,
  SessionStatus,
  AuditEvent,
} from '../src/sessions/store.js';
import { FakeSlackClient } from './responder.test.js';

/**
 * A two-way runner that parks at an `await_approval` gate and records the resume
 * value it gets back, so a test can assert the manager routed the reply/timeout in.
 */
class GateRunner implements SessionRunner {
  public received: GateResume | undefined;
  public sendCount = 0;
  constructor(readonly sessionKey: string) {}
  async *send(_message: string): RunnerStream {
    this.sendCount++;
    yield { type: 'status', text: 'planning…' };
    const resume = yield { type: 'await_approval', prompt: 'PLAN: do the thing' };
    this.received = resume;
    const tail = resume?.kind === 'reply' ? `:${resume.text}` : '';
    yield { type: 'text', text: `resumed:${resume?.kind ?? 'none'}${tail}` };
  }
  async dispose(): Promise<void> {}
}

class GateRunnerFactory implements RunnerFactory {
  public runner: GateRunner | null = null;
  async create(sessionKey: string, _profile: Profile): Promise<SessionRunner> {
    this.runner = new GateRunner(sessionKey);
    return this.runner;
  }
}

/** A store you can seed with one row, for exercising the rehydrate path. */
class SeededStore implements SessionStore {
  private rows = new Map<string, SessionRow>();
  public audits: AuditEvent[] = [];
  seed(row: SessionRow): void {
    this.rows.set(row.session_key, row);
  }
  recordSession(_row: NewSessionRow): void {}
  touch(_key: string, _atMs: number): void {}
  setStatus(_key: string, _status: SessionStatus): void {}
  get(key: string): SessionRow | undefined {
    return this.rows.get(key);
  }
  recordAudit(event: AuditEvent): void { this.audits.push(event); }
  getAuditEvents(_sessionKey: string): AuditEvent[] { return []; }
  listExpired(_cutoffMs: number): SessionRow[] { return []; }
  deleteSession(key: string): void { this.rows.delete(key); }
  close(): void {}
}

function makeManager(idleTimeoutMs = 60_000, script: TurnScript[] = []) {
  const slack = new FakeSlackClient();
  const factory = new FakeRunnerFactory(script);
  const manager = new SessionManager({ idleTimeoutMs, factory, slack });
  return { manager, factory, slack };
}

/** Helper to create a blocking turn: returns [gate, script-entry].
 * Calling gate() lets the turn proceed. */
function blockingTurn(): [() => void, TurnScript] {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const turn: TurnScript = async () => {
    await promise;
    return [{ type: 'text', text: 'done' }] as RunnerEvent[];
  };
  return [resolve, turn];
}

describe('SessionManager — FIFO / serial within session', () => {
  it('processes messages one at a time within a session', async () => {
    const [releaseFirst, firstTurn] = blockingTurn();
    const [, secondTurn] = blockingTurn();
    const { manager: mgr, factory: fac } = makeManager(60_000, [firstTurn, secondTurn]);

    let msg1Started = false;
    let msg2Started = false;

    // Override factory to track when send() is called
    const originalCreate = fac.create.bind(fac);
    let runner: FakeRunner | null = null;
    fac.create = async (key, profile) => {
      runner = (await originalCreate(key, profile)) as FakeRunner;
      return runner;
    };

    await mgr.enqueueNew('TEAM:C:T', {
      message: 'msg1',
      channel: 'C',
      threadTs: 'T',
    });
    await mgr.enqueueNew('TEAM:C:T', {
      message: 'msg2',
      channel: 'C',
      threadTs: 'T',
    });

    // msg1 started draining; msg2 is queued
    await new Promise((r) => setTimeout(r, 5));
    msg1Started = runner !== null && runner.sends.length >= 1;

    // msg2 should NOT have started yet (serial)
    msg2Started = runner !== null && runner.sends.length >= 2;
    expect(msg1Started).toBe(true);
    expect(msg2Started).toBe(false);

    // Now release msg1
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));

    // msg2 should now have started
    expect(runner?.sends).toHaveLength(2);
  });
});

describe('SessionManager — concurrent across sessions', () => {
  it('two sessions process simultaneously', async () => {
    const [releaseA, turnA] = blockingTurn();
    const [releaseB, turnB] = blockingTurn();

    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    // Give each session its own runner with a blocking turn
    let callCount = 0;
    factory.create = async (key) => {
      callCount++;
      const r = new FakeRunner(key, [callCount === 1 ? turnA : turnB]);
      factory.runners.push(r);
      return r;
    };

    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T1', { message: 'hello from T1', channel: 'C', threadTs: 'T1' });
    await manager.enqueueNew('TEAM:C:T2', { message: 'hello from T2', channel: 'C', threadTs: 'T2' });

    await new Promise((r) => setTimeout(r, 5));

    // Both runners should have received their message (processing concurrently)
    const runner1 = factory.runners[0];
    const runner2 = factory.runners[1];
    expect(runner1?.sends).toHaveLength(1);
    expect(runner2?.sends).toHaveLength(1);

    // Release both
    releaseA();
    releaseB();
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('SessionManager — idle reaping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes the runner after IDLE_TIMEOUT_MS and evicts the session', async () => {
    const TIMEOUT = 5_000;
    const { manager, factory } = makeManager(TIMEOUT);

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
    });

    // Drain all pending microtasks/promises by flushing the event loop
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.has('TEAM:C:T')).toBe(true);

    // Advance past the idle timeout
    await vi.advanceTimersByTimeAsync(TIMEOUT + 100);

    expect(manager.has('TEAM:C:T')).toBe(false);
    expect(factory.runners[0]?.disposed).toBe(true);
  });

  it('does not reap a session mid-turn; reaps once the turn completes', async () => {
    const TIMEOUT = 5_000;
    const [release, turn] = blockingTurn();
    const { manager, factory } = makeManager(TIMEOUT, [turn]);

    await manager.enqueueNew('TEAM:C:T', { message: 'slow', channel: 'C', threadTs: 'T' });
    await vi.advanceTimersByTimeAsync(0);

    // Turn is still in flight past the idle timeout — must NOT be reaped
    await vi.advanceTimersByTimeAsync(TIMEOUT + 100);
    expect(manager.has('TEAM:C:T')).toBe(true);
    expect(factory.runners[0]?.disposed).toBe(false);

    // Finish the turn; the next idle window may now reap it
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 100);
    expect(manager.has('TEAM:C:T')).toBe(false);
    expect(factory.runners[0]?.disposed).toBe(true);
  });

  it('a new enqueueNew after reaping creates a fresh runner', async () => {
    const TIMEOUT = 5_000;
    const { manager, factory } = makeManager(TIMEOUT);

    await manager.enqueueNew('TEAM:C:T', {
      message: 'first',
      channel: 'C',
      threadTs: 'T',
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 100);

    expect(factory.creates).toHaveLength(1);

    await manager.enqueueNew('TEAM:C:T', {
      message: 'second',
      channel: 'C',
      threadTs: 'T',
    });
    await vi.advanceTimersByTimeAsync(0);

    // A second factory.create call means a fresh runner was created
    expect(factory.creates).toHaveLength(2);
    expect(factory.runners[0]?.disposed).toBe(true);
    // Second runner is not disposed yet
    expect(factory.runners[1]?.disposed).toBe(false);
  });
});

describe('SessionManager — responder integration', () => {
  it('posts placeholder and updates with final text', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'test',
      channel: 'C',
      threadTs: 'T',
    });
    await new Promise((r) => setTimeout(r, 20));

    // placeholder was posted
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toBe('_thinking…_');

    // updates: FakeRunner emits status then text
    expect(slack.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toBe('Echo: test');
  });

  it('updates placeholder with status events', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', { message: 'hi', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 20));

    // Should have at least the status update and the final text update
    const texts = slack.updates.map((u) => u.text);
    expect(texts).toContain('_processing…_');
    expect(texts).toContain('Echo: hi');
  });

  it('routes error events to the placeholder', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory([
      [{ type: 'error', message: 'something went wrong' }],
    ]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', { message: 'bad', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 20));

    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toContain('something went wrong');
  });
});

describe('SessionManager — enqueueExisting', () => {
  it('returns false and does not create a session', async () => {
    const { manager } = makeManager();
    const result = await manager.enqueueExisting('NO:SESSION', {
      message: 'hi',
      channel: 'C',
      threadTs: 'T',
    });
    expect(result).toBe(false);
    expect(manager.has('NO:SESSION')).toBe(false);
  });
});

describe('SessionManager — file upload', () => {
  it('uploads a file event into the session thread', async () => {
    const slack = new FakeSlackClient();
    const fileData = Buffer.from('svg content', 'utf-8');
    const factory = new FakeRunnerFactory([
      [
        { type: 'file', name: 'output.svg', data: fileData },
        { type: 'text', text: 'here is your svg' },
      ] as RunnerEvent[],
    ]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', { message: 'make svg', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 20));

    expect(slack.uploads).toHaveLength(1);
    const upload = slack.uploads[0];
    expect(upload?.filename).toBe('output.svg');
    expect(upload?.channel).toBe('C');
    expect(upload?.thread_ts).toBe('T');
    expect(upload?.data).toEqual(fileData);
  });

  it('upload failure updates placeholder with error but turn still completes', async () => {
    const slack = new FakeSlackClient();
    slack.uploadError = new Error('upload failed: forbidden');
    const fileData = Buffer.from('data', 'utf-8');
    const factory = new FakeRunnerFactory([
      [
        { type: 'file', name: 'fail.bin', data: fileData },
        { type: 'text', text: 'done anyway' },
      ] as RunnerEvent[],
    ]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', { message: 'test', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 20));

    // Upload failed → error text in placeholder
    const updateTexts = slack.updates.map((u) => u.text);
    expect(updateTexts.some((t) => t.includes('fail.bin'))).toBe(true);
    expect(updateTexts.some((t) => t.includes('upload failed') || t.includes('forbidden'))).toBe(true);

    // Turn still completes — the final text update appears
    expect(updateTexts.some((t) => t === 'done anyway')).toBe(true);
  });
});

describe('SessionManager — approval gate (await_approval)', () => {
  it('parks at the gate, posts the prompt, and a reply resumes the run (not a new turn)', async () => {
    const slack = new FakeSlackClient();
    const factory = new GateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000, // long, so the timeout never fires in this test
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Parked: the plan prompt is posted and the run has not resumed yet.
    expect(slack.updates.some((u) => u.text.includes('PLAN: do the thing'))).toBe(true);
    expect(factory.runner?.received).toBeUndefined();
    expect(manager.has('TEAM:C:T')).toBe(true);

    // The requestor's reply resolves the gate — routed to the parked run, not enqueued.
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    expect(accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(factory.runner?.received).toEqual({ kind: 'reply', text: 'approve' });
    // The reply did NOT start a second send() — it resumed the first.
    expect(factory.runner?.sendCount).toBe(1);
    expect(slack.updates.some((u) => u.text === 'resumed:reply:approve')).toBe(true);
  });

  it('routes a reply that lands while the prompt is still being posted (no race)', async () => {
    // update() is slow, so the prompt post is still in flight when the reply arrives.
    // The fix registers pendingApproval synchronously (before the post), so the reply
    // still routes to the gate; the old ordering would misroute it and the run would hang.
    class SlowSlack extends FakeSlackClient {
      override async update(params: { channel: string; ts: string; text: string }): Promise<void> {
        await new Promise((r) => setTimeout(r, 100));
        await super.update(params);
      }
    }
    // Yields the gate first (no status), so the gate is reached before any slow update().
    class GateFirstRunner implements SessionRunner {
      public received: GateResume | undefined;
      constructor(readonly sessionKey: string) {}
      async *send(_m: string): RunnerStream {
        const resume = yield { type: 'await_approval', prompt: 'PLAN' };
        this.received = resume;
        yield { type: 'text', text: `resumed:${resume?.kind ?? 'none'}` };
      }
      async dispose(): Promise<void> {}
    }
    let runner: GateFirstRunner | null = null;
    const factory: RunnerFactory = {
      create: async (key) => {
        runner = new GateFirstRunner(key);
        return runner;
      },
    };
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack: new SlowSlack(),
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b x',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10)); // gate parked; the slow prompt post is in flight
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    expect(accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    expect(runner?.received).toEqual({ kind: 'reply', text: 'approve' });
  });

  it('resumes with a timeout when no reply arrives within gateTimeoutMs', async () => {
    const slack = new FakeSlackClient();
    const factory = new GateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 20,
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
    });
    await new Promise((r) => setTimeout(r, 60)); // > gateTimeoutMs

    expect(factory.runner?.received).toEqual({ kind: 'timeout' });
    expect(slack.updates.some((u) => u.text === 'resumed:timeout')).toBe(true);
  });
});

describe('SessionManager — gate authorization (requestor-only, M6 #22)', () => {
  it('rejects a non-requestor reply (no resume, no new turn, posts a notice); the requestor still resolves', async () => {
    const slack = new FakeSlackClient();
    const factory = new GateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    // A bystander replies — must NOT resolve the gate and must NOT start a new turn.
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-OTHER',
    });
    expect(accepted).toBe(true); // swallowed (handled), just not as a resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(factory.runner?.received).toBeUndefined(); // still parked
    expect(factory.runner?.sendCount).toBe(1); // the bystander reply did not enqueue a turn
    // The notice is a NEW message (posts), never an update to the gate placeholder.
    expect(
      slack.posts.some((p) => p.text === 'Only <@U-REQ> can approve or cancel this plan.'),
    ).toBe(true);

    // The original requestor can still resolve it.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runner?.received).toEqual({ kind: 'reply', text: 'approve' });
  });

  it('fail-closed: a gate with no recorded requestor rejects every reply', async () => {
    const slack = new FakeSlackClient();
    const factory = new GateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
    });

    // No userId on the creating mention → requestorUserId is undefined.
    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
    });
    await new Promise((r) => setTimeout(r, 10));

    // A reply that DOES carry a userId still cannot match an undefined requestor.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-ANYONE',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(factory.runner?.received).toBeUndefined();
    expect(
      slack.posts.some(
        (p) =>
          p.text === 'Only the person who started this task can approve or cancel this plan.',
      ),
    ).toBe(true);
  });

  it('rehydrate sources the requestor from the stored row, not the replying message', async () => {
    const slack = new FakeSlackClient();
    const factory = new GateRunnerFactory();
    const store = new SeededStore();
    store.seed({
      session_key: 'TEAM:C:T',
      team_id: 'TEAM',
      user_id: 'U-ORIG',
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'supervised-repo-oneshot',
      harness_version: null,
      sdk_session_id: null,
      volume_name: null,
      created_at: 0,
      last_active_at: 0,
      status: 'active',
    });
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
      store,
    });

    // No in-memory session: this reply rehydrates from the store. It is from U-OTHER,
    // but the requestor must be sourced from the row (U-ORIG), not this message.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 10)); // the rehydrated run parks at the gate

    // U-OTHER (who triggered the rehydrate) is NOT the requestor → rejected.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runner?.received).toBeUndefined();
    expect(
      slack.posts.some((p) => p.text === 'Only <@U-ORIG> can approve or cancel this plan.'),
    ).toBe(true);

    // U-ORIG (the stored requestor) CAN resolve it.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-ORIG',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runner?.received).toEqual({ kind: 'reply', text: 'approve' });
  });
});

describe('SessionManager — abandoned event', () => {
  // Parks, then on a cancel reply yields `abandoned`; a finally proves the run was
  // unwound (its cleanup ran) and the post-abandon tail never ran.
  class AbandonRunner implements SessionRunner {
    public finallyRan = false;
    public tailRan = false;
    constructor(readonly sessionKey: string) {}
    async *send(_m: string): RunnerStream {
      try {
        const resume = yield { type: 'await_approval', prompt: 'PLAN' };
        if (resume?.kind === 'reply' && resume.text === 'cancel') {
          yield { type: 'abandoned', reason: 'cancelled' };
        }
        this.tailRan = true;
        yield { type: 'text', text: 'should not run' };
      } finally {
        this.finallyRan = true;
      }
    }
    async dispose(): Promise<void> {}
  }

  it('posts a clean abandon line and unwinds the run (finally runs, tail does not)', async () => {
    const slack = new FakeSlackClient();
    let runner: AbandonRunner | null = null;
    const factory: RunnerFactory = {
      create: async (key) => {
        runner = new AbandonRunner(key);
        return runner;
      },
    };
    const manager = new SessionManager({ idleTimeoutMs: 60_000, gateTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', { message: 'task github:a/b do x', channel: 'C', threadTs: 'T', userId: 'U-REQ' });
    await new Promise((r) => setTimeout(r, 10));
    await manager.enqueueExisting('TEAM:C:T', { message: 'cancel', channel: 'C', threadTs: 'T', userId: 'U-REQ' });
    await new Promise((r) => setTimeout(r, 10));

    expect(
      slack.updates.some((u) => u.text === ':no_entry_sign: Plan abandoned (cancelled) — nothing was pushed.'),
    ).toBe(true);
    expect(slack.updates.some((u) => u.text === 'should not run')).toBe(false);
    expect(runner).not.toBeNull();
    const r = runner as unknown as AbandonRunner;
    expect(r.finallyRan).toBe(true);
    expect(r.tailRan).toBe(false);
  });
});

// ─── SessionManager — audit emission ─────────────────────────────────────────

/**
 * A SessionStore fake that captures audit events for assertion. Also captures
 * recordSession calls (to verify the session was persisted).
 */
class CapturingStore implements SessionStore {
  public audits: AuditEvent[] = [];
  public deletedKeys: string[] = [];
  private rows = new Map<string, SessionRow>();

  recordSession(row: NewSessionRow): void {
    this.rows.set(row.session_key, {
      ...row,
      harness_version: null,
      sdk_session_id: null,
      volume_name: null,
    });
  }
  touch(_key: string, _atMs: number): void {}
  setStatus(key: string, status: SessionStatus): void {
    const r = this.rows.get(key);
    if (r !== undefined) r.status = status;
  }
  get(key: string): SessionRow | undefined {
    return this.rows.get(key);
  }
  recordAudit(event: AuditEvent): void {
    this.audits.push(event);
  }
  getAuditEvents(sessionKey: string): AuditEvent[] {
    return this.audits.filter((a) => a.session_key === sessionKey);
  }
  listExpired(cutoffMs: number): SessionRow[] {
    return Array.from(this.rows.values()).filter(
      (r) => r.last_active_at < cutoffMs,
    );
  }
  deleteSession(key: string): void {
    this.deletedKeys.push(key);
    this.rows.delete(key);
  }
  close(): void {}
}

/** A fake VolumeReaper that records which keys it was asked to remove. */
class FakeVolumeReaper implements VolumeReaper {
  public removedKeys: string[] = [];
  public returnValue: boolean;

  constructor(returnValue = true) {
    this.returnValue = returnValue;
  }

  async removeVolumeForSession(sessionKey: string): Promise<boolean> {
    this.removedKeys.push(sessionKey);
    return this.returnValue;
  }
}

/** A runner that yields a `pr_opened` event so the drain loop handles it. */
class PrOpenedRunner implements SessionRunner {
  constructor(readonly sessionKey: string) {}
  async *send(_m: string): RunnerStream {
    yield { type: 'status', text: 'opening PR…' };
    yield { type: 'pr_opened', url: 'http://x/pr/1' };
  }
  async dispose(): Promise<void> {}
}

describe('SessionManager — audit emission', () => {
  it('emits a lifecycle/created event when a new session is created', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack, store });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20));

    const created = store.audits.filter(
      (a) => a.kind === 'lifecycle' && a.tool === 'session' && a.result === 'created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.team_id).toBe('TEAM');
    expect(created[0]?.user_id).toBe('U1');
    expect(created[0]?.session_key).toBe('TEAM:C:T');
    // Content must never leak into audit fields
    expect(created[0]?.summary).toBeNull();
    expect(created[0]?.reasoning).toBeNull();
  });

  it('emits approval/resolved (requestor) vs approval/rejected_non_requestor (bystander), no content leaked', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new GateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
      store,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    // A bystander tries to approve — must record rejected_non_requestor.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 10));

    const rejected = store.audits.filter((a) => a.result === 'rejected_non_requestor');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.kind).toBe('approval');
    expect(rejected[0]?.tool).toBe('plan-gate');
    expect(rejected[0]?.user_id).toBe('U-OTHER'); // the replier, not the requestor
    // Content must not leak — reply text ('approve') must not appear in any field.
    expect(rejected[0]?.summary).toBeNull();
    expect(rejected[0]?.reasoning).toBeNull();
    const auditJson = JSON.stringify(rejected[0]);
    expect(auditJson).not.toContain('approve');

    // Now the requestor resolves it — must record resolved.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    const resolved = store.audits.filter((a) => a.result === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe('approval');
    expect(resolved[0]?.user_id).toBe('U-REQ');
    // Content must not leak — reply text must not appear.
    const resolvedJson = JSON.stringify(resolved[0]);
    expect(resolvedJson).not.toContain('approve');
  });

  it('emits correction/cancelled when a cancel reply abandons the run', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    let runner: AbandonRunnerForAudit | null = null;
    const factory: RunnerFactory = {
      create: async (key) => {
        runner = new AbandonRunnerForAudit(key);
        return runner;
      },
    };
    const manager = new SessionManager({ idleTimeoutMs: 60_000, gateTimeoutMs: 60_000, factory, slack, store });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    await manager.enqueueExisting('TEAM:C:T', {
      message: 'cancel',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 10));

    const cancelled = store.audits.filter((a) => a.result === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.kind).toBe('correction');
    expect(cancelled[0]?.tool).toBe('plan-gate');
    expect(cancelled[0]?.user_id).toBe('U-REQ');
    // Content must not leak — raw reply text must not appear in free-text fields.
    // ('cancelled' in result is a hardcoded status label, not user content.)
    expect(cancelled[0]?.summary).toBeNull();
    expect(cancelled[0]?.reasoning).toBeNull();
    // The reply message text itself ('cancel') must not appear in summary or reasoning.
    expect(cancelled[0]?.summary).not.toBe('cancel');
    expect(cancelled[0]?.reasoning).not.toBe('cancel');

    expect(runner).not.toBeNull();
  });

  it('emits action/open-pr when pr_opened flows, and placeholder shows "Opened PR:"', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory: RunnerFactory = {
      create: async (key) => new PrOpenedRunner(key),
    };
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack, store });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'task github:a/b do x',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Audit event recorded for the PR.
    const prAudits = store.audits.filter((a) => a.kind === 'action' && a.tool === 'open-pr');
    expect(prAudits).toHaveLength(1);
    expect(prAudits[0]?.result).toBe('opened');
    expect(prAudits[0]?.summary).toBe('http://x/pr/1'); // URL is metadata, not message content
    expect(prAudits[0]?.reasoning).toBeNull();
    expect(prAudits[0]?.cost_tokens).toBeNull();

    // Slack placeholder must show "Opened PR: <url>" (the smoke-harness contract).
    expect(slack.updates.some((u) => u.text.includes('Opened PR:'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('http://x/pr/1'))).toBe(true);
  });

  it('emits a lifecycle/reaped event when a session is reaped', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack, store });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20)); // let the turn drain so reap isn't skipped
    await manager.disposeAll(); // reaps the (now idle) session deterministically

    const reaped = store.audits.filter(
      (a) => a.kind === 'lifecycle' && a.tool === 'session' && a.result === 'reaped',
    );
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.team_id).toBe('TEAM');
    expect(reaped[0]?.user_id).toBe('U1');
    expect(reaped[0]?.summary).toBeNull();
  });

  it('emits a kind:cost audit row when a usage RunnerEvent is received, with no Slack post', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    // Script a single turn that emits a usage event followed by text
    const factory = new FakeRunnerFactory([
      [
        {
          type: 'usage',
          costMicroUsd: 12300,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 20,
        },
        { type: 'text', text: 'done' },
      ],
    ]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack, store });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Exactly one cost audit row
    const costAudits = store.audits.filter((a) => a.kind === 'cost');
    expect(costAudits).toHaveLength(1);
    expect(costAudits[0]?.cost_micro_usd).toBe(12300);
    // cost_tokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
    expect(costAudits[0]?.cost_tokens).toBe(180);
    expect(costAudits[0]?.session_key).toBe('TEAM:C:T');
    expect(costAudits[0]?.team_id).toBe('TEAM');
    expect(costAudits[0]?.user_id).toBe('U1');
    expect(costAudits[0]?.tool).toBeNull();

    // No Slack post triggered by the usage event (silent measurement only)
    // The text reply updates the placeholder; there must be no extra message posted just for cost
    const textUpdates = slack.updates.filter((u) => u.text === 'done');
    expect(textUpdates).toHaveLength(1);
    // Cost value must not appear in any Slack message
    expect(slack.updates.every((u) => !u.text.includes('12300'))).toBe(true);
    expect(slack.posts.every((p) => !p.text.includes('12300'))).toBe(true);
  });

  it('rehydrate emits lifecycle/rehydrated (not a second created) with the stored identity', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    // Seed an evicted session's row; no in-memory session exists, so the reply rehydrates.
    store.recordSession({
      session_key: 'TEAM:C:T',
      team_id: 'TEAM',
      user_id: 'U-ORIG',
      channel_id: 'C',
      thread_ts: 'T',
      profile_id: 'supervised-repo-oneshot',
      created_at: 0,
      last_active_at: 0,
      status: 'active',
    });
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack, store });

    // The rehydrating reply is from U-OTHER, but identity must come from the stored row.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'continue',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 20));

    const lifecycle = store.audits.filter((a) => a.kind === 'lifecycle' && a.tool === 'session');
    // Exactly one lifecycle event, and it is 'rehydrated' — a rehydration must NOT count as a create.
    expect(lifecycle.map((a) => a.result)).toEqual(['rehydrated']);
    expect(lifecycle[0]?.user_id).toBe('U-ORIG'); // stored requestor, not the replier
    expect(lifecycle[0]?.team_id).toBe('TEAM');
  });
});

/** Runner used by the cancel-audit test above (same shape as AbandonRunner). */
class AbandonRunnerForAudit implements SessionRunner {
  public finallyRan = false;
  constructor(readonly sessionKey: string) {}
  async *send(_m: string): RunnerStream {
    try {
      const resume = yield { type: 'await_approval', prompt: 'PLAN' };
      if (resume?.kind === 'reply' && resume.text === 'cancel') {
        yield { type: 'abandoned', reason: 'cancelled' };
      }
      yield { type: 'text', text: 'should not run' };
    } finally {
      this.finallyRan = true;
    }
  }
  async dispose(): Promise<void> {}
}

// ─── SessionManager — volume GC sweep ────────────────────────────────────────

describe('SessionManager — volume GC sweep', () => {
  it('sweep removes an expired row volume and deletes the row', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const store = new CapturingStore();
    const reaper = new FakeVolumeReaper(true);

    // Seed an expired session row directly (last_active_at far in the past).
    store.recordSession({
      session_key: 'TEAM:GC:EXPIRED',
      team_id: 'TEAM',
      user_id: 'U1',
      channel_id: 'GC',
      thread_ts: 'EXPIRED',
      profile_id: 'conversational',
      created_at: 1_000,
      last_active_at: 1_000,
      status: 'reaped',
    });

    // Default gcIntervalMs (1h) so the background interval never fires during the test;
    // the sweep is invoked directly for determinism (no wall-clock waits).
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      volumeReaper: reaper,
      volumeTtlMs: 1_000, // the seeded row (last_active_at=1000) is well past the cutoff
    });

    await manager.runVolumeGc();

    // Reaper should have been called for the expired key.
    expect(reaper.removedKeys).toContain('TEAM:GC:EXPIRED');
    // Row should have been deleted from the store.
    expect(store.get('TEAM:GC:EXPIRED')).toBeUndefined();

    await manager.disposeAll();
  });

  it('sweep skips a live in-memory session (never rm a volume in use)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const store = new CapturingStore();
    const reaper = new FakeVolumeReaper(true);

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      volumeReaper: reaper,
      volumeTtlMs: 1_000,
    });

    // Create a live session — getOrCreate registers it in the in-memory map before
    // enqueueNew resolves, so it is live the moment this await returns.
    await manager.enqueueNew('TEAM:GC:LIVE', {
      message: 'hello',
      channel: 'GC',
      threadTs: 'LIVE',
      teamId: 'TEAM',
    });

    // Back-date the store row so it looks expired.
    const row = store.get('TEAM:GC:LIVE');
    if (row !== undefined) {
      // Update last_active_at to 1 (far in the past).
      // We do this by re-inserting (CapturingStore's recordSession is an upsert-like).
      store.recordSession({
        session_key: row.session_key,
        team_id: row.team_id,
        user_id: row.user_id,
        channel_id: row.channel_id,
        thread_ts: row.thread_ts,
        profile_id: row.profile_id,
        created_at: 1,
        last_active_at: 1,
        status: row.status,
      });
    }

    await manager.runVolumeGc();

    // The session is still live in memory → reaper must NOT have been called for it.
    expect(reaper.removedKeys).not.toContain('TEAM:GC:LIVE');
    // Row is still in the store.
    expect(store.get('TEAM:GC:LIVE')).toBeDefined();

    await manager.disposeAll();
  });

  it('sweep leaves the row when reaper returns false (retried next sweep)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const store = new CapturingStore();
    const reaper = new FakeVolumeReaper(false); // always fails

    store.recordSession({
      session_key: 'TEAM:GC:FAIL',
      team_id: null,
      user_id: null,
      channel_id: 'GC',
      thread_ts: 'FAIL',
      profile_id: 'conversational',
      created_at: 1,
      last_active_at: 1,
      status: 'reaped',
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      volumeReaper: reaper,
      volumeTtlMs: 1_000,
    });

    await manager.runVolumeGc();

    // Reaper was called but returned false — row must remain.
    expect(reaper.removedKeys).toContain('TEAM:GC:FAIL');
    expect(store.deletedKeys).not.toContain('TEAM:GC:FAIL');
    expect(store.get('TEAM:GC:FAIL')).toBeDefined();

    await manager.disposeAll();
  });

  it('does not delete the row if the session is re-created while the rm is in flight (TOCTOU)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const store = new CapturingStore();

    store.recordSession({
      session_key: 'TEAM:GC:RACE',
      team_id: 'TEAM',
      user_id: null,
      channel_id: 'GC',
      thread_ts: 'RACE',
      profile_id: 'conversational',
      created_at: 1,
      last_active_at: 1,
      status: 'reaped',
    });

    // A reaper that re-creates the session mid-removal — simulating a reply arriving
    // while `docker volume rm` is in flight. The post-await liveness re-check must then
    // leave the (now-live) row alone.
    const ref: { mgr?: SessionManager } = {};
    const reaper: VolumeReaper = {
      async removeVolumeForSession(key: string): Promise<boolean> {
        await ref.mgr?.enqueueNew(key, {
          message: 'back',
          channel: 'GC',
          threadTs: 'RACE',
          teamId: 'TEAM',
        });
        return true;
      },
    };
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      volumeReaper: reaper,
      volumeTtlMs: 1_000,
    });
    ref.mgr = manager;

    await manager.runVolumeGc();

    // The session came back to life during the rm → its index row must survive.
    expect(manager.has('TEAM:GC:RACE')).toBe(true);
    expect(store.deletedKeys).not.toContain('TEAM:GC:RACE');

    await manager.disposeAll();
  });

  it('GC is off when no volumeReaper is passed (no calls to store delete path)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const store = new CapturingStore();

    // Seed an expired row.
    store.recordSession({
      session_key: 'TEAM:GC:NOgc',
      team_id: null,
      user_id: null,
      channel_id: 'GC',
      thread_ts: 'NOgc',
      profile_id: 'conversational',
      created_at: 1,
      last_active_at: 1,
      status: 'reaped',
    });

    // No volumeReaper → GC interval is never started, and the sweep is a no-op even if
    // invoked: with no reaper there is nothing to remove a volume, so no row is deleted.
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      // volumeReaper intentionally omitted
    });

    await manager.runVolumeGc();

    // The expired row must survive — without a reaper, GC deletes nothing.
    expect(store.deletedKeys).toHaveLength(0);
    expect(store.get('TEAM:GC:NOgc')).toBeDefined();

    await manager.disposeAll();
  });
});
