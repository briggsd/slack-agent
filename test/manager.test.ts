import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/sessions/manager.js';
import { FakeRunnerFactory, FakeRunner } from '../src/runner/fake.js';
import type { TurnScript } from '../src/runner/fake.js';
import type { RunnerEvent } from '../src/runner/types.js';
import { FakeSlackClient } from './responder.test.js';

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
    fac.create = async (key: string) => {
      runner = (await originalCreate(key)) as FakeRunner;
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
    factory.create = async (key: string) => {
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
  it('returns false and does not create a session', () => {
    const { manager } = makeManager();
    const result = manager.enqueueExisting('NO:SESSION', {
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
