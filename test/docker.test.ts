/**
 * Unit tests for DockerRunner and DockerRunnerFactory.
 *
 * Uses a FakeChildProcess (PassThrough-based stdio + EventEmitter) to avoid
 * spawning real Docker containers. All tests are offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner, DockerRunnerFactory, sanitizeKey, volumeNameFor } from '../src/runner/docker.js';
import type { DockerRunnerConfig, SpawnFn } from '../src/runner/docker.js';
import type { RunnerFactory } from '../src/runner/types.js';
import { SessionManager } from '../src/sessions/manager.js';
import { FakeSlackClient } from './responder.test.js';

// ── FakeChildProcess ──────────────────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  /** Lines written to stdin by the DockerRunner */
  stdinLines: string[] = [];
  private stdinBuf = '';

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    // Capture lines written to stdin
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.stdinBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl: number;
      while ((nl = this.stdinBuf.indexOf('\n')) !== -1) {
        this.stdinLines.push(this.stdinBuf.slice(0, nl));
        this.stdinBuf = this.stdinBuf.slice(nl + 1);
      }
    });
  }

  /** Simulate the runner writing a line to stdout */
  writeOut(line: string): void {
    this.stdout.push(line + '\n');
  }

  /** Simulate the runner writing to stderr */
  writeErr(line: string): void {
    this.stderr.push(line + '\n');
  }

  /** Simulate the process exiting */
  simulateExit(code: number | null = 0): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  /** Cast to ChildProcess for use in DockerRunner */
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(): boolean {
    return true;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DockerRunnerConfig = {
  image: 'slackbot-runner:test',
  readyTimeoutMs: 1_000,
  turnTimeoutMs: 2_000,
  absoluteTurnTimeoutMs: 30 * 60_000,
  killGraceMs: 100,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
};

async function makeReadyRunner(): Promise<{
  runner: DockerRunner;
  fake: FakeChildProcess;
}> {
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);

  // Race ready-wait and ready-emission
  const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;

  return { runner, fake };
}

// ── sanitizeKey ───────────────────────────────────────────────────────────────

describe('sanitizeKey', () => {
  it('replaces colons and special chars with hyphens', () => {
    expect(sanitizeKey('TEAM123:C123:T456')).toBe('team123-c123-t456');
  });

  it('lowercases', () => {
    expect(sanitizeKey('ABC')).toBe('abc');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeKey(long)).toHaveLength(64);
  });

  it('3-segment key stays ≤64 chars and clean (no colons or uppercase)', () => {
    const key = 'T123456789ABCDEF:C123456789012345678:1234567890.123456';
    const result = sanitizeKey(key);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).not.toMatch(/[A-Z:]/u);
    expect(result).toMatch(/^[a-z0-9-]+$/u);
  });
});

// ── Ready handshake ───────────────────────────────────────────────────────────

describe('DockerRunner — ready handshake', () => {
  it('resolves when runner emits ready', async () => {
    const fake = new FakeChildProcess();
    const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);

    const readyPromise = DockerRunner.waitReady(runner, 1_000);
    fake.writeOut(JSON.stringify({ type: 'ready' }));
    await expect(readyPromise).resolves.toBeUndefined();
  });

  it('rejects if process exits before ready', async () => {
    const fake = new FakeChildProcess();
    const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);

    const readyPromise = DockerRunner.waitReady(runner, 1_000);
    fake.simulateExit(1);
    await expect(readyPromise).rejects.toThrow('Runner exited before sending ready');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeChildProcess();
      const runner = new DockerRunner(fake.asChildProcess(), { ...DEFAULT_CONFIG, readyTimeoutMs: 500 });

      const readyPromise = DockerRunner.waitReady(runner, 500);
      // Attach a no-op rejection handler immediately to avoid unhandled rejection
      // (the rejection races with advanceTimersByTimeAsync)
      readyPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(600);
      await expect(readyPromise).rejects.toThrow('ready within 500ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores non-ready lines before the ready message', async () => {
    const fake = new FakeChildProcess();
    const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);

    const readyPromise = DockerRunner.waitReady(runner, 1_000);
    fake.writeOut('not json');
    fake.writeOut(JSON.stringify({ type: 'status', id: 'x', text: 'hi' }));
    fake.writeOut(JSON.stringify({ type: 'ready' }));
    await expect(readyPromise).resolves.toBeUndefined();
  });
});

// ── Message round-trip ────────────────────────────────────────────────────────

describe('DockerRunner — send/receive', () => {
  it('writes user_message to stdin and yields text event', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('hello');
    const iter = gen[Symbol.asyncIterator]();

    // Read the first event (which requires the runner to write back)
    const nextPromise = iter.next();

    // Capture the user_message written to stdin
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.stdinLines).toHaveLength(1);
    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string; text: string };
    expect(sent.type).toBe('user_message');
    expect(sent.text).toBe('hello');

    // Simulate runner responding
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'world' }));

    const result = await nextPromise;
    expect(result.value).toEqual({ type: 'text', text: 'world' });
    expect((await iter.next()).done).toBe(true);
  });

  it('yields interleaved status events then text', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('hi');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({ type: 'status', id: sent.id, text: 'thinking' }));
    fake.writeOut(JSON.stringify({ type: 'status', id: sent.id, text: 'searching' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done!' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'thinking' });

    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'status', text: 'searching' });

    const e3 = await iter.next();
    expect(e3.value).toEqual({ type: 'text', text: 'done!' });

    expect((await iter.next()).done).toBe(true);
  });

  it('yields error event on runner error response', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('bad');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({ type: 'error', id: sent.id, message: 'oops' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'error', message: 'oops', reason: 'runner_error' });
    expect((await iter.next()).done).toBe(true);
  });

  it('threads a valid errorClass through the wire-parse site', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('go');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({ type: 'error', id: sent.id, message: 'max turns hit', errorClass: 'max_turns' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'error', message: 'max turns hit', reason: 'runner_error', errorClass: 'max_turns' });
    expect((await iter.next()).done).toBe(true);
  });

  it('drops a bogus errorClass off the wire to undefined (validation)', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('go');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({ type: 'error', id: sent.id, message: 'oops', errorClass: 'haxx' }));

    const e1 = await e1Promise;
    // errorClass not present (dropped) — no errorClass field on the event
    expect(e1.value).toEqual({ type: 'error', message: 'oops', reason: 'runner_error' });
    expect((await iter.next()).done).toBe(true);
  });

  it('yields error on unexpected process exit during send', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('msg');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    fake.simulateExit(137);

    const e1 = await e1Promise;
    expect(e1.value).toEqual({
      type: 'error',
      message: 'runner process exited unexpectedly (code=137, signal=null)',
      reason: 'container_exit',
    });
  });

  it('maps protocol file message to RunnerEvent with decoded Buffer', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('make a file');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    const originalContent = 'hello from file';
    const data_base64 = Buffer.from(originalContent, 'utf-8').toString('base64');

    // Emit file message then text message
    fake.writeOut(JSON.stringify({ type: 'file', id: sent.id, name: 'output.txt', data_base64, size: 15 }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({ type: 'file', name: 'output.txt' });
    // data should be a Buffer with the decoded content
    const fileEvent = e1.value as { type: 'file'; name: string; data: Buffer };
    expect(fileEvent.data).toBeInstanceOf(Buffer);
    expect(fileEvent.data.toString('utf-8')).toBe(originalContent);

    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });

  it('emits status (not crash) on malformed base64 in file message', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('make a file');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    // Emit a file message with bad base64, then text
    // Note: Buffer.from with 'base64' is actually very lenient and may not throw;
    // the test verifies the guard path doesn't crash and the turn still completes.
    fake.writeOut(JSON.stringify({ type: 'file', id: sent.id, name: 'bad.bin', data_base64: '!!!notbase64!!!', size: 0 }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    // Collect all events
    const events: unknown[] = [];
    let next = await e1Promise;
    while (!next.done) {
      events.push(next.value);
      next = await iter.next();
    }

    // Should not crash; should eventually yield the text event
    const textEvent = events.find((e) => (e as { type: string }).type === 'text');
    expect(textEvent).toBeDefined();
  });
});

// ── Trust-boundary coercion for usage fields ─────────────────────────────────

describe('DockerRunner — usage field coercion at trust boundary', () => {
  it('coerces bad usage fields (negative, string, missing, non-finite) to 0', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('coerce me');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    // Emit a usage message with malformed fields, then text to terminate the turn.
    fake.writeOut(JSON.stringify({
      type: 'usage',
      id: sent.id,
      costMicroUsd: -5,          // negative → 0
      inputTokens: 'x',          // non-number → 0
      outputTokens: undefined,   // missing (serialises as absent) → 0
      cacheReadTokens: Infinity, // JSON.stringify(Infinity) → null, so non-number → 0
      cacheCreationTokens: -0.1, // negative → 0
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'ok' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({
      type: 'usage',
      costMicroUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'text', text: 'ok' });
    expect((await iter.next()).done).toBe(true);
  });

  it('passes through well-formed usage fields and rounds fractional values', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('good usage');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({
      type: 'usage',
      id: sent.id,
      costMicroUsd: 1.6,       // rounds to 2
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 200,
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({
      type: 'usage',
      costMicroUsd: 2,          // 1.6 rounded
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 200,
    });

    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });
});

// ── Partial line buffering ────────────────────────────────────────────────────

describe('DockerRunner — NDJSON framing with chunk splits', () => {
  it('buffers partial stdout chunks until newline', async () => {
    const fake = new FakeChildProcess();
    const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);

    // Deliver ready in two chunks
    const readyJson = JSON.stringify({ type: 'ready' });
    const readyPromise = DockerRunner.waitReady(runner, 1_000);

    // Push the ready message in two pieces (mid-line split)
    fake.stdout.push(readyJson.slice(0, 5));
    await new Promise((r) => setTimeout(r, 5));
    fake.stdout.push(readyJson.slice(5) + '\n');

    await expect(readyPromise).resolves.toBeUndefined();
  });

  it('buffers partial text line mid-message', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('test');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };
    const textMsg = JSON.stringify({ type: 'text', id: sent.id, text: 'split response' });

    // Deliver in three chunks
    fake.stdout.push(textMsg.slice(0, 10));
    await new Promise((r) => setTimeout(r, 5));
    fake.stdout.push(textMsg.slice(10, 20));
    await new Promise((r) => setTimeout(r, 5));
    fake.stdout.push(textMsg.slice(20) + '\n');

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'split response' });
  });
});

// ── Per-turn timeout ──────────────────────────────────────────────────────────

describe('DockerRunner — per-turn timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('yields timeout error and leaves runner usable after turn timeout', async () => {
    const fake = new FakeChildProcess();
    const cfg: DockerRunnerConfig = { ...DEFAULT_CONFIG, turnTimeoutMs: 500 };
    const runner = new DockerRunner(fake.asChildProcess(), cfg);

    const readyPromise = DockerRunner.waitReady(runner, 1_000);
    fake.writeOut(JSON.stringify({ type: 'ready' }));
    await readyPromise;

    const gen = runner.send('slow');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    // Advance past the turn timeout
    await vi.advanceTimersByTimeAsync(600);

    const e1 = await e1Promise;
    expect(e1.value).toEqual({
      type: 'error',
      message: expect.stringContaining('timed out'),
      reason: 'timeout',
    });
    expect((await iter.next()).done).toBe(true);

    // Runner should still be usable (not disposed)
    expect(runner['disposed']).toBe(false);
  });
});

// ── dispose ───────────────────────────────────────────────────────────────────

describe('DockerRunner — dispose', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends SIGTERM then SIGKILL after grace period', async () => {
    const fake = new FakeChildProcess();
    const killSpy = vi.spyOn(fake, 'kill');
    const cfg: DockerRunnerConfig = { ...DEFAULT_CONFIG, killGraceMs: 200 };
    const runner = new DockerRunner(fake.asChildProcess(), cfg);

    const disposePromise = runner.dispose();

    // Let SIGTERM go out
    await vi.advanceTimersByTimeAsync(0);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');

    // Advance past grace without process exit → SIGKILL
    await vi.advanceTimersByTimeAsync(300);
    await disposePromise;

    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills the container by name on escalation (SIGKILL on the CLI alone orphans it)', async () => {
    vi.useFakeTimers();
    const fake = new FakeChildProcess();
    const spawnCalls: { command: string; args: string[] }[] = [];
    const spawnFn: SpawnFn = (command, args) => {
      spawnCalls.push({ command, args });
      return new FakeChildProcess().asChildProcess();
    };
    const cfg: DockerRunnerConfig = { ...DEFAULT_CONFIG, killGraceMs: 200 };
    const runner = new DockerRunner(fake.asChildProcess(), cfg, {
      containerName: 'slackbot-team01-c123-t456',
      spawnFn,
    });

    const disposePromise = runner.dispose();
    await vi.advanceTimersByTimeAsync(250);
    await disposePromise;

    expect(spawnCalls).toContainEqual({
      command: 'docker',
      args: ['kill', 'slackbot-team01-c123-t456'],
    });
    vi.useRealTimers();
  });

  it('does not crash the gateway when stdin emits an error (broken pipe)', async () => {
    const { fake } = await makeReadyRunner();
    // With no 'error' listener this would throw an uncaught exception
    expect(() => fake.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('does not SIGKILL if process exits during grace', async () => {
    const fake = new FakeChildProcess();
    const killSpy = vi.spyOn(fake, 'kill');
    const cfg: DockerRunnerConfig = { ...DEFAULT_CONFIG, killGraceMs: 500 };
    const runner = new DockerRunner(fake.asChildProcess(), cfg);

    const disposePromise = runner.dispose();
    await vi.advanceTimersByTimeAsync(0);

    // Simulate process exiting gracefully before grace period
    fake.simulateExit(0);
    await vi.advanceTimersByTimeAsync(0);
    await disposePromise;

    // SIGTERM was sent, but SIGKILL should NOT have been called
    const sigkillCalls = killSpy.mock.calls.filter((c) => c[0] === 'SIGKILL');
    expect(sigkillCalls).toHaveLength(0);
  });
});

// ── DockerRunnerFactory ───────────────────────────────────────────────────────

describe('DockerRunnerFactory', () => {
  it('constructs correct docker argv (image, volume, limits, env inheritance)', async () => {
    const capturedArgs: string[] = [];
    let capturedCommand = '';

    const fakeSpawn: SpawnFn = (cmd, args) => {
      capturedCommand = cmd;
      capturedArgs.push(...args);
      const fake = new FakeChildProcess();
      // Immediately emit ready so factory.create() resolves
      setTimeout(() => {
        fake.writeOut(JSON.stringify({ type: 'ready' }));
      }, 5);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_CONFIG, fakeSpawn);
    const runner = await factory.create('TEAM01:C123:T456', { id: 'conversational', label: 'Conversational' });

    expect(capturedCommand).toBe('docker');
    expect(capturedArgs).toContain('run');
    expect(capturedArgs).toContain('--rm');
    expect(capturedArgs).toContain('-i');

    // Volume name
    const volIdx = capturedArgs.indexOf('-v');
    expect(volIdx).toBeGreaterThan(-1);
    const volArg = capturedArgs[volIdx + 1] ?? '';
    expect(volArg).toMatch(/^slackbot-ws-team01-c123-t456:\/workspace$/);

    // Container name
    const nameIdx = capturedArgs.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(capturedArgs[nameIdx + 1]).toBe('slackbot-team01-c123-t456');

    // Image
    expect(capturedArgs[capturedArgs.length - 1]).toBe(DEFAULT_CONFIG.image);

    // Env inheritance — must be `-e ANTHROPIC_API_KEY` NOT `-e ANTHROPIC_API_KEY=...`
    const eIdx = capturedArgs.indexOf('-e');
    expect(eIdx).toBeGreaterThan(-1);
    expect(capturedArgs[eIdx + 1]).toBe('ANTHROPIC_API_KEY');
    // Make sure the key value itself does NOT appear in argv
    for (const arg of capturedArgs) {
      expect(arg).not.toMatch(/ANTHROPIC_API_KEY=/);
    }

    // Resource limits
    expect(capturedArgs).toContain('--memory');
    expect(capturedArgs).toContain('512m');
    expect(capturedArgs).toContain('--cpus');
    expect(capturedArgs).toContain('1.0');
    expect(capturedArgs).toContain('--pids-limit');
    expect(capturedArgs).toContain('256');
    expect(capturedArgs).toContain('--security-opt');
    expect(capturedArgs).toContain('no-new-privileges');

    await runner.dispose();
  });

  it('rejects create() if container exits before ready', async () => {
    const fakeSpawn: SpawnFn = () => {
      const fake = new FakeChildProcess();
      setTimeout(() => fake.simulateExit(1), 10);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_CONFIG, fakeSpawn);
    await expect(factory.create('key')).rejects.toThrow();
  });
});

// ── DockerRunnerFactory.removeVolumeForSession ────────────────────────────────

describe('DockerRunnerFactory — removeVolumeForSession', () => {
  it('spawns docker volume rm with the correct args and resolves true on exit 0', async () => {
    const sessionKey = 'T:C:TH';
    const expectedVolumeArg = volumeNameFor(sessionKey); // 'slackbot-ws-t-c-th'

    const spawnCalls: { command: string; args: string[] }[] = [];
    const fakeSpawn: SpawnFn = (command, args) => {
      spawnCalls.push({ command, args });
      const fake = new FakeChildProcess();
      // Simulate immediate successful exit
      setTimeout(() => fake.simulateExit(0), 5);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_CONFIG, fakeSpawn);
    const result = await factory.removeVolumeForSession(sessionKey);

    expect(result).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe('docker');
    expect(spawnCalls[0]?.args).toEqual(['volume', 'rm', expectedVolumeArg]);
  });

  it('resolves true on "No such volume" stderr (already absent)', async () => {
    const fakeSpawn: SpawnFn = (_command, _args) => {
      const fake = new FakeChildProcess();
      setTimeout(() => {
        fake.writeErr('Error response from daemon: No such volume: slackbot-ws-t-c-th');
        fake.simulateExit(1);
      }, 5);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_CONFIG, fakeSpawn);
    const result = await factory.removeVolumeForSession('T:C:TH');
    expect(result).toBe(true);
  });

  it('resolves false on other failure (non-zero exit, no "No such volume")', async () => {
    const fakeSpawn: SpawnFn = (_command, _args) => {
      const fake = new FakeChildProcess();
      setTimeout(() => {
        fake.writeErr('volume is in use - slackbot-ws-t-c-th');
        fake.simulateExit(1);
      }, 5);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_CONFIG, fakeSpawn);
    const result = await factory.removeVolumeForSession('T:C:TH');
    expect(result).toBe(false);
  });
});

// ── Per-turn cost ceiling (Slice B1) ──────────────────────────────────────────

describe('DockerRunner — per-turn cost ceiling (PER_TURN_COST_CEILING_MICRO_USD)', () => {
  it('a usage line with costMicroUsd above the ceiling is yielded clamped to 20_000_000', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('test');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    // costMicroUsd far above the $20 ceiling
    fake.writeOut(JSON.stringify({
      type: 'usage',
      id: sent.id,
      costMicroUsd: 99_000_000, // $99 — way above ceiling
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({
      type: 'usage',
      costMicroUsd: 20_000_000, // clamped to ceiling
    });

    // Token fields pass through unchanged
    expect((e1.value as { inputTokens: number }).inputTokens).toBe(100);
    expect((e1.value as { outputTokens: number }).outputTokens).toBe(50);
  });

  it('a normal costMicroUsd value (below ceiling) passes through without clamping', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('test2');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({
      type: 'usage',
      id: sent.id,
      costMicroUsd: 1_500_000, // $1.50 — well below ceiling
      inputTokens: 50,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheCreationTokens: 10,
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({
      type: 'usage',
      costMicroUsd: 1_500_000, // not clamped
    });
  });

  it('costMicroUsd exactly at the ceiling passes through unchanged', async () => {
    const { runner, fake } = await makeReadyRunner();

    const gen = runner.send('test3');
    const iter = gen[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(fake.stdinLines[0] ?? '{}') as { type: string; id: string };

    fake.writeOut(JSON.stringify({
      type: 'usage',
      id: sent.id,
      costMicroUsd: 20_000_000, // exactly at ceiling
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: sent.id, text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toMatchObject({
      type: 'usage',
      costMicroUsd: 20_000_000,
    });
  });
});

// ── Commit gate: request_approval ↔ approval_verdict translation (S10a) ─────────

describe('DockerRunner — commit gate translation', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  /** Capture the turn id the runner wrote as its user_message. */
  function turnId(fake: FakeChildProcess): string {
    const line = fake.stdinLines.find((entry) => JSON.parse(entry).type === 'user_message') ?? '{}';
    return (JSON.parse(line) as { id: string }).id;
  }

  it('surfaces request_approval as a non-blocking approval_requested event and the turn continues', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner.send('build a thing')[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await tick();

    const firstTurnId = turnId(fake);
    fake.writeOut(JSON.stringify({ type: 'request_approval', id: 'appr-1', specRef: 'SPEC: do X' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: firstTurnId, text: 'approval requested' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({
      type: 'approval_requested',
      approvalId: 'appr-1',
      prompt: 'SPEC: do X',
      specRef: 'SPEC: do X',
    });
    expect(fake.stdinLines.some((l) => l.includes('approval_verdict'))).toBe(false);
    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'text', text: 'approval requested' });
    expect((await iter.next()).done).toBe(true);
  });

  it('send(..., { approval }) writes approval_verdict before the next user_message', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner
      .send('build a thing', {
        approval: { id: 'appr-2', specRef: 'SPEC: do X', approved: false, feedback: 'make it faster please' },
      })
      [Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    expect(JSON.parse(fake.stdinLines[0] ?? '{}')).toEqual({
      type: 'approval_verdict',
      id: 'appr-2',
      specRef: 'SPEC: do X',
      approved: false,
      feedback: 'make it faster please',
    });
    expect(JSON.parse(fake.stdinLines[1] ?? '{}')).toMatchObject({
      type: 'user_message',
      text: 'build a thing',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'revised' }));
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'revised' });
  });

  it('send(..., { approval }) supports approval without feedback too', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner
      .send('build a thing', { approval: { id: 'appr-3', specRef: 'SPEC: do X', approved: true } })
      [Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();
    expect(JSON.parse(fake.stdinLines[0] ?? '{}')).toEqual({
      type: 'approval_verdict',
      id: 'appr-3',
      specRef: 'SPEC: do X',
      approved: true,
    });
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'built' }));
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'built' });
  });

  it('fails the turn if stdin is gone before approval control and user_message can be written', async () => {
    const { runner, fake } = await makeReadyRunner();
    fake.stdin.destroy();

    const iter = runner
      .send('build a thing', { approval: { id: 'appr-6', specRef: 'SPEC: do X', approved: true } })
      [Symbol.asyncIterator]();
    const e2 = await iter.next();
    expect(e2.value).toEqual({ type: 'error', message: 'runner stdin is not writable', reason: 'runner_error' });
    expect((await iter.next()).done).toBe(true);
  });

  it('a malformed request_approval (has id, missing specRef) is skipped without writing approval_verdict', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner.send('build a thing')[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await tick();
    fake.writeOut(JSON.stringify({ type: 'request_approval', id: 'appr-5' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done anyway' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done anyway' });
    expect(fake.stdinLines.some((l) => l.includes('approval_verdict'))).toBe(false);
  });
});

// ── Commit gate end-to-end through SessionManager (S10a) ────────────────────────

describe('SessionManager + DockerRunner — commit gate end-to-end', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it('container gate ends the first turn, then a requestor reply starts a second send with approval control first', async () => {
    const fake = new FakeChildProcess();
    const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);
    const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
    fake.writeOut(JSON.stringify({ type: 'ready' }));
    await readyPromise;

    const factory: RunnerFactory = { create: async () => runner };
    const slack = new FakeSlackClient();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      gateTimeoutMs: 60_000,
      factory,
      slack,
    });

    await manager.enqueueNew('TEAM:C:T', {
      message: 'build a thing',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await tick();

    const firstTurnId = (JSON.parse(fake.stdinLines[0] ?? '{}') as { id: string }).id;

    // The container raises the commit gate from inside the turn.
    fake.writeOut(JSON.stringify({ type: 'request_approval', id: 'appr-9', specRef: 'SPEC: ship it' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: firstTurnId, text: 'APPROVAL REQUESTED' }));
    await tick();

    // (a) The prompt is posted, but the first turn is allowed to complete.
    expect(slack.updates.some((u) => u.text.includes('SPEC: ship it'))).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('APPROVAL REQUESTED'))).toBe(true);

    // (b) A non-requestor cannot resolve it — no verdict crosses to the container.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-OTHER',
    });
    await tick();
    expect(fake.stdinLines.some((l) => l.includes('approval_verdict'))).toBe(false);
    expect(
      slack.posts.some((p) => p.text === 'Only <@U-REQ> can approve or cancel this plan.'),
    ).toBe(true);

    // (c) The requestor approves → a second send writes approval_verdict before user_message.
    await manager.enqueueExisting('TEAM:C:T', {
      message: 'approve',
      channel: 'C',
      threadTs: 'T',
      userId: 'U-REQ',
    });
    await tick();
    const verdictLine = fake.stdinLines.find((l) => l.includes('approval_verdict') && l.includes('"id":"appr-9"'));
    expect(verdictLine).toBeDefined();
    expect(JSON.parse(verdictLine ?? '{}')).toEqual({
      type: 'approval_verdict',
      id: 'appr-9',
      specRef: 'SPEC: ship it',
      approved: true,
    });
    const verdictIndex = fake.stdinLines.findIndex((l) => l === verdictLine);
    expect(JSON.parse(fake.stdinLines[verdictIndex + 1] ?? '{}')).toMatchObject({
      type: 'user_message',
      text: 'approve',
    });

    // The second turn completes after approval.
    const secondTurnId = (JSON.parse(fake.stdinLines[verdictIndex + 1] ?? '{}') as { id: string }).id;
    fake.writeOut(JSON.stringify({ type: 'text', id: secondTurnId, text: 'shipped' }));
    await tick();
    expect(slack.updates.some((u) => u.text === 'shipped')).toBe(true);
  });
});
