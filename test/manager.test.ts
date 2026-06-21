import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/sessions/manager.js';
import { FakeRunnerFactory, FakeRunner } from '../src/runner/fake.js';
import type { TurnScript } from '../src/runner/fake.js';
import type {
  ApprovalControl,
  RunnerEvent,
  RunnerStream,
  SessionRunner,
  RunnerFactory,
  GateResume,
  VolumeReaper,
  BuildRunnerFactory,
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

class BuildSpecGateRunner implements SessionRunner {
  public sendCount = 0;
  public approvals: Array<ApprovalControl | undefined> = [];
  public messages: string[] = [];

  constructor(readonly sessionKey: string) {}

  async *send(message: string, opts?: { approval?: ApprovalControl }): RunnerStream {
    this.sendCount++;
    this.messages.push(message);
    this.approvals.push(opts?.approval);
    if (this.sendCount === 1) {
      yield { type: 'approval_requested', approvalId: 'appr-build-1', prompt: 'SPEC: do the thing', specRef: 'SPEC: do the thing' };
      yield { type: 'text', text: 'APPROVAL REQUESTED' };
      return;
    }
    const approval = opts?.approval;
    yield {
      type: 'text',
      text: approval?.approved
        ? `resumed:${message}:approved`
        : `resumed:${message}:${approval?.feedback ?? 'rejected'}`,
    };
  }

  async dispose(): Promise<void> {}
}

class BuildSpecGateRunnerFactory implements RunnerFactory {
  public runners: BuildSpecGateRunner[] = [];

  async create(sessionKey: string, _profile: Profile): Promise<SessionRunner> {
    const runner = new BuildSpecGateRunner(sessionKey);
    this.runners.push(runner);
    return runner;
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
  sumCostByTask(_sessionKey: string): number { return 0; }
  sumCostByUserSince(_userId: string, _sinceMs: number): number { return 0; }
  sumCostGlobalSince(_sinceMs: number): number { return 0; }
  hasExecOptIn(_teamId: string, _userId: string): boolean { return false; }
  recordExecOptIn(_teamId: string, _userId: string, _atMs: number): void {}
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

describe('SessionManager — build_spec approval_requested', () => {
  it('lets the first turn finish, then the requestor reply starts a second turn with approval control', async () => {
    const slack = new FakeSlackClient();
    const factory = new BuildSpecGateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'build this',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(factory.runners).toHaveLength(1);
    expect(factory.runners[0]?.sendCount).toBe(1);
    expect(factory.runners[0]?.approvals[0]).toBeUndefined();
    expect(slack.updates.some((u) => u.text.includes('SPEC: do the thing'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('APPROVAL REQUESTED'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('no approval timeout'))).toBe(false);
    expect(slack.updates.some((u) => u.text.includes('Reply `approve` to build this SPEC'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('`reject` or `cancel` to abort'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('very late replies may start a new turn'))).toBe(true);

    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    expect(accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(factory.runners[0]?.sendCount).toBe(2);
    expect(factory.runners[0]?.messages[1]).toBe('approve');
    expect(factory.runners[0]?.approvals[1]).toEqual({
      id: 'appr-build-1',
      specRef: 'SPEC: do the thing',
      approved: true,
    });
    expect(slack.updates.some((u) => u.text === 'resumed:approve:approved')).toBe(true);
  });

  it('can recreate the runner while approval is pending, then consume the requestor reply on the next turn', async () => {
    const slack = new FakeSlackClient();
    const factory = new BuildSpecGateRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 20,
      gateTimeoutMs: 60_000,
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'build this',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 50)); // allow idle reap of the runner only

    expect(manager.has('TEAM:C:T')).toBe(true);
    expect(factory.runners).toHaveLength(1);

    await manager.enqueueExisting('TEAM:C:T', {
      message: 'needs more detail',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(factory.runners).toHaveLength(2);
    expect(factory.runners[1]?.approvals[0]).toEqual({
      id: 'appr-build-1',
      specRef: 'SPEC: do the thing',
      approved: false,
      feedback: 'needs more detail',
    });
    expect(factory.runners[1]?.messages[0]).toBe('needs more detail');
  });

  it('checks spend caps before a build_spec approval reply starts the resume turn', async () => {
    const slack = new FakeSlackClient();
    const factory = new BuildSpecGateRunnerFactory();
    const store = new CapturingStore();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 3_000_000, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'build this',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(factory.runners[0]?.sendCount).toBe(1);

    store.recordAudit({
      session_key: 'TEAM:C:T',
      team_id: 'TEAM',
      user_id: 'U-REQ',
      ts: Date.now(),
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 5_000_000,
    });

    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    expect(accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(factory.runners[0]?.sendCount).toBe(1);
    expect(slack.posts.some((p) => p.text.includes('reached its budget'))).toBe(true);
    const capAudits = store.audits.filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:task');
    const resolved = store.audits.filter(
      (a) => a.kind === 'approval' && a.tool === 'build_spec' && a.result === 'resolved',
    );
    expect(resolved).toHaveLength(0);
  });

  it('bounds in-memory retention after reaping a runner with pending build_spec approval', async () => {
    const slack = new FakeSlackClient();
    const factory = new BuildSpecGateRunnerFactory();
    const store = new CapturingStore();
    const manager = new SessionManager({
      idleTimeoutMs: 10,
      pendingApprovalRetentionMs: 35,
      gateTimeoutMs: 60_000,
      factory,
      slack,
      store,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'build this',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 25));

    expect(manager.has('TEAM:C:T')).toBe(true);
    expect(store.get('TEAM:C:T')?.status).toBe('active');
    expect(
      store.audits.filter((a) => a.kind === 'lifecycle' && a.tool === 'session' && a.result === 'reaped'),
    ).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 60));

    expect(manager.has('TEAM:C:T')).toBe(false);
    expect(store.get('TEAM:C:T')?.status).toBe('reaped');
    expect(factory.runners).toHaveLength(1);
    const reaped = store.audits.filter(
      (a) => a.kind === 'lifecycle' && a.tool === 'session' && a.result === 'reaped',
    );
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.team_id).toBe('TEAM');
    expect(reaped[0]?.user_id).toBe('U-REQ');
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
 * recordSession calls (to verify the session was persisted). Implements the three
 * SUM methods (B1) by computing from the in-memory audits array.
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

  sumCostByTask(sessionKey: string): number {
    return this.audits
      .filter((a) => a.session_key === sessionKey && a.cost_micro_usd !== null)
      .reduce((sum, a) => sum + (a.cost_micro_usd ?? 0), 0);
  }

  sumCostByUserSince(userId: string, sinceMs: number): number {
    return this.audits
      .filter((a) => a.user_id === userId && a.ts > sinceMs && a.cost_micro_usd !== null)
      .reduce((sum, a) => sum + (a.cost_micro_usd ?? 0), 0);
  }

  sumCostGlobalSince(sinceMs: number): number {
    return this.audits
      .filter((a) => a.ts > sinceMs && a.cost_micro_usd !== null)
      .reduce((sum, a) => sum + (a.cost_micro_usd ?? 0), 0);
  }

  hasExecOptIn(teamId: string, userId: string): boolean {
    return this.execOptIns.has(`${teamId}:${userId}`);
  }

  recordExecOptIn(teamId: string, userId: string, _atMs: number): void {
    this.execOptIns.add(`${teamId}:${userId}`);
  }

  private readonly execOptIns = new Set<string>();
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

  it('a started exec reconciles to a terminal audit (started → succeeded_pr), summary is the PR URL only', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    store.recordExecOptIn('TEAM', 'U-REQ', Date.now());
    const routerFactory = new FakeRunnerFactory([
      [
        { type: 'run_exec', host: 'github', repo: 'a/b', instruction: 'ship it' },
        { type: 'text', text: 'router resumed' },
      ] as RunnerEvent[],
    ]);
    const buildRunnerFactory: BuildRunnerFactory = {
      createBuildRunner: () => Promise.reject(new Error('build not used in this test')),
      createExecRunner: (key) => Promise.resolve(new PrOpenedRunner(key)),
    };
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 30));

    // Every 'started' exec must reconcile to a terminal status — no dangling 'started'
    // row for a capability that bypasses the human gate.
    const execAudits = store.audits.filter((a) => a.kind === 'action' && a.tool === 'exec');
    expect(execAudits.map((a) => a.result)).toEqual(['started', 'succeeded_pr']);
    // The only metadata recorded is the gateway-controlled PR URL; no message content leaks.
    const terminal = execAudits[1];
    expect(terminal?.summary).toBe('http://x/pr/1');
    expect(terminal?.user_id).toBe('U-REQ');
    expect(terminal?.reasoning).toBeNull();
  });

  it('exec refuses a bystander turn author who lacks the opt-in, even when the requestor is opted in', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    store.recordExecOptIn('TEAM', 'U-REQ', Date.now()); // the requestor IS opted in
    // turn 0: the requestor's opening message; turn 1: a bystander's reply drives run_exec.
    const routerFactory = new FakeRunnerFactory([
      [{ type: 'text', text: 'hi' }] as RunnerEvent[],
      [
        { type: 'run_exec', host: 'github', repo: 'a/b', instruction: 'ship it' },
        { type: 'text', text: 'router resumed' },
      ] as RunnerEvent[],
    ]);
    let execCreateCount = 0;
    const buildRunnerFactory: BuildRunnerFactory = {
      createBuildRunner: () => Promise.reject(new Error('build not used in this test')),
      createExecRunner: (key) => {
        execCreateCount += 1;
        return Promise.resolve(new PrOpenedRunner(key));
      },
    };
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-REQ',
    });
    await new Promise((r) => setTimeout(r, 20));

    // A bystander (not opted in) replies and the coordinator tries to exec.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'exec it',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Refused on the bystander's missing opt-in — the requestor's standing opt-in must NOT
    // carry over to a different turn author.
    expect(execCreateCount).toBe(0);
    const refused = store.audits.filter(
      (a) => a.tool === 'exec' && a.result === 'refused_no_opt_in',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.user_id).toBe('U-OTHER'); // the replier, not the requestor
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

// ─── SessionManager — spend-caps enforcement ─────────────────────────────────

/**
 * A runner that yields a scripted usage event per turn. Each call to send()
 * pops the next costMicroUsd from the list (looping to the last value).
 */
class CostRunner implements SessionRunner {
  public sends: string[] = [];
  private costs: number[];
  private idx = 0;
  constructor(costs: number[]) {
    this.costs = costs.length > 0 ? costs : [0];
  }
  send(message: string): RunnerStream {
    this.sends.push(message);
    const cost = this.costs[Math.min(this.idx++, this.costs.length - 1)] ?? 0;
    async function* gen(): RunnerStream {
      yield { type: 'usage', costMicroUsd: cost, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      yield { type: 'text', text: 'ok' };
    }
    return gen();
  }
  async dispose(): Promise<void> {}
}

class CostRunnerFactory implements RunnerFactory {
  constructor(private costs: number[]) {}
  async create(_key: string, _profile: Profile): Promise<SessionRunner> {
    return new CostRunner(this.costs);
  }
}

describe('SessionManager — spend-caps enforcement', () => {
  it('admission rejects enqueueNew when per-user-24h cap is breached, posts message, records audit', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    let nowMs = 1_000_000;

    // Pre-seed a cost row for U1 inside the 24h window
    store.recordAudit({
      session_key: 'OLD:C:T',
      team_id: 'TEAM',
      user_id: 'U1',
      ts: nowMs - 1000, // 1 second ago — within 24h
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 5_000_000, // $5 already spent
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 3_000_000, perGlobal24hMicroUsd: 0 },
      now: () => nowMs,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 10));

    // No runner was created — session was not started
    expect(factory.creates).toHaveLength(0);
    expect(manager.has('TEAM:C:T')).toBe(false);

    // A message was posted to the user
    expect(slack.posts.length).toBeGreaterThan(0);
    const capPost = slack.posts.find((p) => p.text.includes('daily spend limit'));
    expect(capPost).toBeDefined();

    // An audit row was recorded
    const capAudits = store.audits.filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:user');
    expect(capAudits[0]?.user_id).toBe('U1');

    // No cost/message content in audit fields
    expect(capAudits[0]?.summary).toBeNull();
    expect(capAudits[0]?.reasoning).toBeNull();
    // The posted message must not contain the raw spend number
    expect(capPost?.text).not.toContain('5000000');
  });

  it('admission rejects enqueueNew when global-24h cap is breached', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    let nowMs = 2_000_000;

    store.recordAudit({
      session_key: 'ANY:C:T',
      team_id: 'TEAM',
      user_id: 'OTHER',
      ts: nowMs - 100,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 10_000_000, // $10 global spend
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 5_000_000 },
      now: () => nowMs,
    });

    await manager.enqueueNew('TEAM:C:T2', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T2',
      teamId: 'TEAM',
      userId: 'U-NEW',
    });

    expect(factory.creates).toHaveLength(0);
    const capAudits = store.audits.filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:global');

    // Global message must not reveal other users' spend details
    const capPost = slack.posts.find((p) => p.text.includes('workspace daily spend limit'));
    expect(capPost).toBeDefined();
    expect(capPost?.text).not.toContain('OTHER');
  });

  it('admission rejects on the rehydrate path, keyed on the STORED requestor (per-user cap)', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    const nowMs = 3_000_000;

    // Seed an evicted session owned by U-ORIG (so a reply rehydrates rather than hits memory)...
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
    // ...plus a prior cost row attributed to U-ORIG that breaches the per-user cap.
    store.recordAudit({
      session_key: 'PRIOR:C:T',
      team_id: 'TEAM',
      user_id: 'U-ORIG',
      ts: nowMs - 1000, // within 24h
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 8_000_000, // $8 already spent
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 3_000_000, perGlobal24hMicroUsd: 0 },
      now: () => nowMs,
    });

    // The reply is from U-OTHER and triggers the rehydrate path; the cap check must key on
    // the STORED requestor (U-ORIG), not the replier, and reject before any rehydration.
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'continue',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U-OTHER',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Thread is known → handled (true), but nothing rehydrated.
    expect(accepted).toBe(true);
    expect(factory.creates).toHaveLength(0);
    expect(
      store.audits.filter((a) => a.kind === 'lifecycle' && a.tool === 'session'),
    ).toHaveLength(0);

    // Rejected on per-user, attributed to the STORED requestor (not the replier).
    const capAudits = store.audits.filter(
      (a) => a.kind === 'correction' && a.tool === 'spend-cap',
    );
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:user');
    expect(capAudits[0]?.user_id).toBe('U-ORIG');
    expect(capAudits[0]?.team_id).toBe('TEAM');
  });

  it('fails closed: a store SUM error refuses the turn (rejected:error), no run started', async () => {
    const slack = new FakeSlackClient();
    class ThrowingStore extends CapturingStore {
      override sumCostByTask(): number {
        throw new Error('db down');
      }
    }
    const store = new ThrowingStore();
    const factory = new FakeRunnerFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 5_000_000, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
      now: () => 1_000_000,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Failed closed — no container/run started.
    expect(factory.creates).toHaveLength(0);
    expect(manager.has('TEAM:C:T')).toBe(false);
    // Honest "couldn't verify" message + a rejected:error audit row.
    const capAudits = store.audits.filter(
      (a) => a.kind === 'correction' && a.tool === 'spend-cap',
    );
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:error');
    expect(slack.posts.find((p) => p.text.includes("Couldn't verify"))).toBeDefined();
  });

  it('admission rejects enqueueExisting (in-memory hit) when per-task cap is breached', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 3_000_000, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
      now: () => Date.now(),
    });

    // Create the session first
    await manager.enqueueNew('TEAM:C:T', {
      message: 'first turn',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20));

    // Manually seed a cost row for this session (simulating the first turn cost)
    store.recordAudit({
      session_key: 'TEAM:C:T',
      team_id: 'TEAM',
      user_id: 'U1',
      ts: Date.now(),
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 5_000_000, // $5 — exceeds $3 cap
    });

    const prevPosts = slack.posts.length;
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'second turn',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 10));

    // enqueueExisting returns true (the thread is known)
    expect(accepted).toBe(true);
    // No drain happened for the second turn
    const capAudits = store.audits.filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('rejected:task');
    // A message was posted
    expect(slack.posts.length).toBeGreaterThan(prevPosts);
    const capPost = slack.posts[slack.posts.length - 1];
    expect(capPost?.text).toContain('Start a new thread');
  });

  it('mid-task: abandon triggered when turn 2 is queued while turn 1 runs and cap is crossed by turn 1', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();

    // Turn 1: $5 cost (above $4 cap). Turn 1 is blocking — released after turn 2 is queued.
    let releaseTurn1!: () => void;
    const turn1Done = new Promise<void>((res) => { releaseTurn1 = res; });

    const turn1Script: TurnScript = async () => {
      await turn1Done;
      return [
        { type: 'usage', costMicroUsd: 5_000_000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        { type: 'text', text: 'turn 1 done' },
      ] as RunnerEvent[];
    };

    const factory = new FakeRunnerFactory([turn1Script]);

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 4_000_000, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
      now: () => Date.now(),
    });

    // Start turn 1 — it blocks, draining = true
    const enqueue1 = manager.enqueueNew('TEAM:C:T', {
      message: 'turn 1',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    // Wait for drain to start (session is now draining)
    await new Promise((r) => setTimeout(r, 10));

    // Enqueue turn 2 while turn 1 is running. Admission check: sumCostByTask = 0 (nothing
    // recorded yet), so admission passes and turn 2 is queued.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'turn 2',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    // No cap audits yet — turn 1 hasn't recorded its cost
    expect(store.audits.filter((a) => a.tool === 'spend-cap')).toHaveLength(0);

    // Release turn 1 — it records $5 to the store, then drain loops to turn 2
    releaseTurn1();
    await enqueue1;
    await new Promise((r) => setTimeout(r, 20)); // let drain run the post-turn-1 loop iteration

    // Second turn should NOT have been dispatched (mid-task abandon fires first)
    const capAudits = store.audits.filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    expect(capAudits[0]?.result).toBe('abandoned:task');
    expect(capAudits[0]?.user_id).toBe('U1');

    // A "nothing was pushed" message was posted
    const capPost = slack.posts.find((p) => p.text.includes('reached its budget'));
    expect(capPost).toBeDefined();

    // Queue was cleared
    const session = manager['sessions'].get('TEAM:C:T');
    expect(session?.queue.length ?? 0).toBe(0);

    // No message content leaked into audit fields
    expect(capAudits[0]?.summary).toBeNull();
    expect(capAudits[0]?.reasoning).toBeNull();
    const auditJson = JSON.stringify(capAudits[0]);
    expect(auditJson).not.toContain('turn 2');
  });

  it('a 0-disabled cap is not enforced even when accumulated spend would exceed it', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new CostRunnerFactory([50_000_000]); // $50/turn — huge

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      // All caps disabled (0)
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'turn 1',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20));

    await manager.enqueueExisting('TEAM:C:T', {
      message: 'turn 2',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 20));

    // No cap audit rows
    const capAudits = store.audits.filter((a) => a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(0);
  });

  it('unknown userId skips the per-user check but global still fires', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    let nowMs = 3_000_000;

    // Seed a large global spend
    store.recordAudit({
      session_key: 'ANY:C:T',
      team_id: null,
      user_id: null,
      ts: nowMs - 100,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 10_000_000,
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 1_000_000, perGlobal24hMicroUsd: 5_000_000 },
      now: () => nowMs,
    });

    // No userId — per-user check must be skipped; global should still reject
    await manager.enqueueNew('TEAM:C:T3', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T3',
      teamId: 'TEAM',
      // userId intentionally omitted
    });

    expect(factory.creates).toHaveLength(0);
    const capAudits = store.audits.filter((a) => a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(1);
    // Must be global, not user
    expect(capAudits[0]?.result).toBe('rejected:global');
  });

  it('per-user rows older than 24h (via injected clock) do not count toward the cap', async () => {
    const slack = new FakeSlackClient();
    const store = new CapturingStore();
    const factory = new FakeRunnerFactory();
    // now = 100h in ms; 24h window starts at 76h
    const nowMs = 100 * 60 * 60 * 1000;

    // Seed a row at 50h — older than 24h, should NOT count
    store.recordAudit({
      session_key: 'OLD:C:T',
      team_id: null,
      user_id: 'U1',
      ts: 50 * 60 * 60 * 1000,
      kind: 'cost',
      tool: null,
      summary: null,
      reasoning: null,
      result: null,
      cost_tokens: null,
      cost_micro_usd: 10_000_000, // $10, but outside window
    });

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory,
      slack,
      store,
      spendCaps: { perTaskMicroUsd: 0, perUser24hMicroUsd: 5_000_000, perGlobal24hMicroUsd: 0 },
      now: () => nowMs,
    });

    await manager.enqueueNew('TEAM:C:T4', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T4',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Session was created — old row didn't count
    expect(factory.creates).toHaveLength(1);
    const capAudits = store.audits.filter((a) => a.tool === 'spend-cap');
    expect(capAudits).toHaveLength(0);
  });

  it('default SessionManager (no spendCaps) is unaffected — existing tests still pass', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();

    // No spendCaps in constructor — caps default to disabled
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'hello',
      channel: 'C',
      threadTs: 'T',
    });
    await new Promise((r) => setTimeout(r, 10));

    // Session was created and processed normally
    expect(factory.creates).toHaveLength(1);
    expect(slack.posts.length).toBeGreaterThanOrEqual(1); // placeholder posted

    await manager.disposeAll();
  });
});
