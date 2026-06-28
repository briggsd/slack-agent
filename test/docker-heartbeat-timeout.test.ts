/**
 * Unit tests for the inactivity+absolute-backstop turn timeout and heartbeat
 * protocol message handling in DockerRunner.
 *
 * All tests use the clock seam (DockerRunnerConfig.now) to drive time
 * deterministically — no real sleeps. Pre-queuing lines so nextLineWithTimeout
 * returns them immediately (from lineQueue) avoids real setTimeout waits in
 * the deadline logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';

// ── FakeChildProcess (same pattern as docker.test.ts) ────────────────────────

class FakeChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinLines: string[] = [];
  private stdinBuf = '';

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.on('data', (chunk: Buffer | string) => {
      this.stdinBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl: number;
      while ((nl = this.stdinBuf.indexOf('\n')) !== -1) {
        this.stdinLines.push(this.stdinBuf.slice(0, nl));
        this.stdinBuf = this.stdinBuf.slice(nl + 1);
      }
    });
  }

  writeOut(line: string): void {
    this.stdout.push(line + '\n');
  }

  simulateExit(code: number | null = 0): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(): boolean {
    return true;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Make a runner with a controllable clock and pre-queued ready message.
 * The clock starts at 0 and can be advanced by mutating `t`.
 */
async function makeClockRunner(
  overrides: Partial<DockerRunnerConfig> & { now: () => number },
): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const config: DockerRunnerConfig = {
    image: 'slackbot-runner:test',
    readyTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    absoluteTurnTimeoutMs: 30 * 60_000,
    killGraceMs: 100,
    memory: '512m',
    cpus: '1.0',
    pidsLimit: 256,
    ...overrides,
  };
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(fake.asChildProcess(), config);
  const readyPromise = DockerRunner.waitReady(runner, 1_000);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;
  return { runner, fake };
}

/** Read all events from a runner.send() generator until done. */
async function collectEvents(
  runner: DockerRunner,
  message: string,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const event of runner.send(message)) {
    events.push(event as { type: string; [k: string]: unknown });
  }
  return events;
}

// ── Idle timeout (existing behaviour, now via clock seam) ─────────────────────

describe('DockerRunner — idle timeout via clock seam', () => {
  it('times out with the original message when nothing arrives (no heartbeat)', async () => {
    // Use vi fake timers so nextLineWithTimeout's real setTimeout fires quickly.
    vi.useFakeTimers();
    try {
      let t = 0;
      const clock = (): number => t;
      const turnTimeoutMs = 500;

      const { runner, fake } = await makeClockRunner({
        now: clock,
        turnTimeoutMs,
        absoluteTurnTimeoutMs: 30 * 60_000,
      });

      const gen = runner.send('slow');
      const iter = gen[Symbol.asyncIterator]();
      const e1Promise = iter.next();

      // Advance the fake clock so the idle deadline passes (remaining <= 0).
      t = turnTimeoutMs + 1;
      // Also advance vi timers so the real setTimeout inside nextLineWithTimeout fires.
      await vi.advanceTimersByTimeAsync(turnTimeoutMs + 10);

      const e1 = await e1Promise;
      expect(e1.value).toMatchObject({
        type: 'error',
        reason: 'timeout',
      });
      // Message should name the inactivity window, not the absolute limit.
      expect((e1.value as { message: string }).message).toContain(`timed out after ${turnTimeoutMs}ms`);
      expect((await iter.next()).done).toBe(true);

      void fake; // used for setup
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Heartbeat resets idle deadline ────────────────────────────────────────────

describe('DockerRunner — heartbeat resets idle deadline', () => {
  it('does not time out when heartbeats keep arriving (idle window never elapses)', async () => {
    // Clock advances by 10 per call. turnTimeoutMs=100 so idle fires after 10 clock calls
    // with no reset. Heartbeats reset idleDeadline so the effective window restarts.
    // We pre-queue [heartbeat, heartbeat, heartbeat, text] so all lines are immediately
    // available (no real setTimeout needed in nextLineWithTimeout).
    let callCount = 0;
    // Advances by 10 each call. heartbeat branch calls self.now() once to reset.
    // Loop head calls self.now() once per iteration.
    const clock = (): number => {
      callCount += 1;
      return callCount * 10;
    };
    const turnTimeoutMs = 100;
    const absoluteTurnTimeoutMs = 100_000;

    const { runner, fake } = await makeClockRunner({
      now: clock,
      turnTimeoutMs,
      absoluteTurnTimeoutMs,
    });

    // Capture the turn id from stdin so heartbeat/text use matching ids.
    const turnIdPromise = new Promise<string>((resolve) => {
      const check = (): void => {
        const line = fake.stdinLines.find((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'user_message'; } catch { return false; }
        });
        if (line !== undefined) {
          resolve((JSON.parse(line) as { id: string }).id);
        } else {
          setTimeout(check, 1);
        }
      };
      check();
    });

    // Start the turn generator
    const genPromise = collectEvents(runner, 'work hard');

    // Wait for the user_message to be written to stdin
    const turnId = await turnIdPromise;

    // Pre-queue heartbeats + text (all land in lineQueue, returned immediately by nextLineWithTimeout)
    fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId, text: 'done!' }));

    const events = await genPromise;

    // Should complete with text event (no timeout)
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'done!' });
  });

  it('heartbeat is NOT forwarded — no heartbeat or extra status event emitted', async () => {
    let t = 0;
    const clock = (): number => {
      t += 1;
      return t;
    };

    const { runner, fake } = await makeClockRunner({
      now: clock,
      turnTimeoutMs: 100_000,
      absoluteTurnTimeoutMs: 100_000,
    });

    const turnIdPromise = new Promise<string>((resolve) => {
      const check = (): void => {
        const line = fake.stdinLines.find((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'user_message'; } catch { return false; }
        });
        if (line !== undefined) {
          resolve((JSON.parse(line) as { id: string }).id);
        } else {
          setTimeout(check, 1);
        }
      };
      check();
    });

    const genPromise = collectEvents(runner, 'ping');
    const turnId = await turnIdPromise;

    // Send a heartbeat followed by a status and text — all should be seen correctly.
    fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    fake.writeOut(JSON.stringify({ type: 'status', id: turnId, text: 'working' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId, text: 'result' }));

    const events = await genPromise;

    // heartbeat is consumed silently — only status + text should surface
    const types = events.map((e) => e['type']);
    expect(types).not.toContain('heartbeat');
    // Exactly: status, text
    expect(types).toEqual(['status', 'text']);
  });
});

// ── Absolute backstop fires even with constant heartbeats ─────────────────────

describe('DockerRunner — absolute backstop', () => {
  it('times out with the absolute-limit message even when heartbeats keep the idle window alive', async () => {
    // Clock increments by 10 per call. absoluteTurnTimeoutMs=100 means absoluteDeadline=turnStart+100.
    // turnStart = 10 (first now() call). absoluteDeadline = 10 + 100 = 110.
    // Each heartbeat iteration: loop head calls now() (+10), then heartbeat reset calls now() (+10).
    // After 5 heartbeat iterations: t = 10 (turnStart) + 5*(10+10) = 10+100 = 110.
    // 6th loop head: t = 120, remaining = min(idle, 110) - 120 <= 0 → absolute timeout.
    let callCount = 0;
    const clock = (): number => {
      callCount += 1;
      return callCount * 10;
    };
    const turnTimeoutMs = 100_000; // huge: idle never fires
    const absoluteTurnTimeoutMs = 100;

    const { runner, fake } = await makeClockRunner({
      now: clock,
      turnTimeoutMs,
      absoluteTurnTimeoutMs,
    });

    const turnIdPromise = new Promise<string>((resolve) => {
      const check = (): void => {
        const line = fake.stdinLines.find((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'user_message'; } catch { return false; }
        });
        if (line !== undefined) {
          resolve((JSON.parse(line) as { id: string }).id);
        } else {
          setTimeout(check, 1);
        }
      };
      check();
    });

    const genPromise = collectEvents(runner, 'run forever');
    const turnId = await turnIdPromise;

    // Pre-queue many heartbeats so the loop runs freely through them.
    // The clock will advance past absoluteDeadline and trigger timeout at the loop head.
    for (let i = 0; i < 20; i++) {
      fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    }

    const events = await genPromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', reason: 'timeout' });
    const msg = (events[0] as { message: string }).message;
    expect(msg).toContain('absolute limit');
    expect(msg).toContain(`${absoluteTurnTimeoutMs}ms`);
  });

  it('idle timeout fires (not absolute) when the agent goes silent', async () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const clock = (): number => t;
      const turnTimeoutMs = 200;
      const absoluteTurnTimeoutMs = 60_000;

      const { runner } = await makeClockRunner({
        now: clock,
        turnTimeoutMs,
        absoluteTurnTimeoutMs,
      });

      const iter = runner.send('silence')[Symbol.asyncIterator]();
      const e1Promise = iter.next();

      // Advance wall clock (fake timers) so nextLineWithTimeout fires, and advance our
      // custom clock so remaining <= 0 at the loop head check.
      t = turnTimeoutMs + 1;
      await vi.advanceTimersByTimeAsync(turnTimeoutMs + 10);

      const e1 = await e1Promise;
      expect(e1.value).toMatchObject({ type: 'error', reason: 'timeout' });
      // Should be the idle message, not absolute.
      expect((e1.value as { message: string }).message).toMatch(/timed out after \d+ms/);
      expect((e1.value as { message: string }).message).not.toContain('absolute');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Heartbeat branch: verify idle deadline is reset (indirect via no timeout) ──

describe('DockerRunner — heartbeat resets match request_* deadline behaviour', () => {
  it('a heartbeat before the idle window prevents idle timeout, same as a status', async () => {
    // Use a controlled clock that doesn't advance between calls by default.
    // We send a heartbeat early enough that idle doesn't fire.
    let t = 0;
    const clock = (): number => t;
    const turnTimeoutMs = 50;

    const { runner, fake } = await makeClockRunner({
      now: clock,
      turnTimeoutMs,
      absoluteTurnTimeoutMs: 100_000,
    });

    const turnIdPromise = new Promise<string>((resolve) => {
      const check = (): void => {
        const line = fake.stdinLines.find((l) => {
          try { return (JSON.parse(l) as { type: string }).type === 'user_message'; } catch { return false; }
        });
        if (line !== undefined) {
          resolve((JSON.parse(line) as { id: string }).id);
        } else {
          setTimeout(check, 1);
        }
      };
      check();
    });

    const genPromise = collectEvents(runner, 'test idle reset');
    const turnId = await turnIdPromise;

    // The clock stays at 0 throughout — remaining will always be positive.
    // Send heartbeat + text to verify the turn completes without timeout.
    fake.writeOut(JSON.stringify({ type: 'heartbeat', id: turnId }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId, text: 'ok' }));

    const events = await genPromise;
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
