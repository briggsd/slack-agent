import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';

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

  writeOut(line: string): void { this.stdout.push(line + '\n'); }
  asChildProcess(): ChildProcess { return this as unknown as ChildProcess; }
  kill(): boolean { return true; }
}

const DEFAULT_CONFIG: DockerRunnerConfig = {
  image: 'slackbot-runner:test',
  readyTimeoutMs: 1_000,
  turnTimeoutMs: 2_000,
  killGraceMs: 100,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
};

async function makeReadyRunner(): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);
  const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;
  return { runner, fake };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function turnId(fake: FakeChildProcess): string {
  return (JSON.parse(fake.stdinLines[0] ?? '{}') as { id: string }).id;
}

describe('DockerRunner — decision dispatch + protocol skips', () => {
  it('yields a decision event for a valid one-way decision line on the active turn id', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('verify it')[Symbol.asyncIterator]();
    const first = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'decision',
      id: turnId(fake),
      point: 'verify',
      verdict: 'fail',
      rationale: 'Checks were skipped and the diff left an unreviewed migration.',
      correlationId: 'build-9',
    }));

    expect((await first).value).toEqual({
      type: 'decision',
      point: 'verify',
      verdict: 'fail',
      rationale: 'Checks were skipped and the diff left an unreviewed migration.',
      correlationId: 'build-9',
    });

    const second = iter.next();
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await second).value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });

  it('skips a malformed decision line (treat container output as data) and keeps draining', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('verify it')[Symbol.asyncIterator]();
    const first = iter.next();
    await tick();

    // Invalid verdict — must yield a protocol_skip event, not a decision event, and not be fatal.
    fake.writeOut(JSON.stringify({
      type: 'decision',
      id: turnId(fake),
      point: 'verify',
      verdict: 'maybe',
      rationale: 'not a real verdict',
    }));
    // The protocol_skip event surfaces first, then the terminal text.
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    expect((await first).value).toEqual({ type: 'protocol_skip', reason: 'decision_invalid', bytes: expect.any(Number) });
    expect((await iter.next()).value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });

  it('yields a protocol_skip (json_parse) for an unparseable line and then drains normally', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('hello')[Symbol.asyncIterator]();
    const first = iter.next();
    await tick();

    // Deliberately unparseable — not valid JSON.
    fake.writeOut('not json{');

    const firstResult = await first;
    expect(firstResult.value).toEqual({
      type: 'protocol_skip',
      reason: 'json_parse',
      bytes: expect.any(Number),
    });
    expect((firstResult.value as { bytes: number }).bytes).toBeGreaterThan(0);

    // Turn still drains to terminal text after the skip.
    const second = iter.next();
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await second).value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });
});
