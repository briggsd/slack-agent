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
} from '../src/runner/types.js';
import type { Profile } from '../src/profiles/registry.js';
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
    });
    await new Promise((r) => setTimeout(r, 10));

    // Parked: the plan prompt is posted and the run has not resumed yet.
    expect(slack.updates.some((u) => u.text.includes('PLAN: do the thing'))).toBe(true);
    expect(factory.runner?.received).toBeUndefined();
    expect(manager.has('TEAM:C:T')).toBe(true);

    // A thread reply resolves the gate — routed to the parked run, not enqueued.
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
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
    });
    await new Promise((r) => setTimeout(r, 10)); // gate parked; the slow prompt post is in flight
    const accepted = await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
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
