/**
 * Unit tests for the request_run_checks ↔ run_checks_result round-trip through DockerRunner.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import { FakeCheckService } from '../src/runner/fake-check-service.js';

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

async function makeReadyRunner(opts?: {
  checkService?: FakeCheckService;
  volume?: string;
}): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(
    fake.asChildProcess(),
    DEFAULT_CONFIG,
    undefined,
    undefined,
    opts?.volume,
    undefined,
    opts?.checkService,
  );
  const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;
  return { runner, fake };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

async function waitForStdinLine(
  fake: FakeChildProcess,
  pred: (l: string) => boolean,
  maxMs = 200,
): Promise<string | undefined> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const found = fake.stdinLines.find(pred);
    if (found !== undefined) return found;
    await tick();
  }
  return undefined;
}

function turnId(fake: FakeChildProcess): string {
  return (JSON.parse(fake.stdinLines[0] ?? '{}') as { id: string }).id;
}

describe('DockerRunner — request_run_checks round-trip', () => {
  it('request_run_checks → status + run_checks_result{ok:true} written back', async () => {
    const checkService = new FakeCheckService();
    checkService.setOutcome({
      ok: true,
      results: [
        { kind: 'lint', exitCode: 1, skipped: false, output: 'lint raw' },
        { kind: 'test', exitCode: 0, skipped: false, output: 'test raw' },
      ],
    });
    const { runner, fake } = await makeReadyRunner({ checkService, volume: 'slackbot-ws-test' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_run_checks',
      id: 'checks-1',
      repo: 'owner/repo',
      kind: 'all',
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'running checks for owner/repo...' });

    const e2Promise = iter.next();
    const checksResultLine = await waitForStdinLine(fake, (l) => l.includes('run_checks_result'));
    expect(checksResultLine).toBeDefined();
    expect(JSON.parse(checksResultLine ?? '{}')).toEqual({
      type: 'run_checks_result',
      id: 'checks-1',
      ok: true,
      results: [
        { kind: 'lint', exitCode: 1, skipped: false, output: 'lint raw' },
        { kind: 'test', exitCode: 0, skipped: false, output: 'test raw' },
      ],
    });
    expect(checkService.checks).toEqual([{ repo: 'owner/repo', volume: 'slackbot-ws-test', kind: 'all' }]);

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
  });

  it('omitted kind defaults to all', async () => {
    const checkService = new FakeCheckService();
    const { runner, fake } = await makeReadyRunner({ checkService, volume: 'vol' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_run_checks', id: 'checks-2', repo: 'owner/repo' }));

    await e1Promise;
    const e2Promise = iter.next();
    const checksResultLine = await waitForStdinLine(fake, (l) => l.includes('run_checks_result'));
    expect(checksResultLine).toBeDefined();
    expect(checkService.checks).toEqual([{ repo: 'owner/repo', volume: 'vol', kind: 'all' }]);

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    await e2Promise;
  });

  it('malformed repo/kind writes malformed result and does not call service', async () => {
    const checkService = new FakeCheckService();
    const { runner, fake } = await makeReadyRunner({ checkService, volume: 'vol' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_run_checks', id: 'checks-3', repo: 'owner/repo', kind: 'build' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    const checksResultLine = fake.stdinLines.find((l) => l.includes('run_checks_result'));
    expect(checksResultLine).toBeDefined();
    expect(JSON.parse(checksResultLine ?? '{}')).toEqual({
      type: 'run_checks_result',
      id: 'checks-3',
      ok: false,
      reason: 'malformed request',
    });
    expect(checkService.checks).toHaveLength(0);
  });

  it('malformed repo shape writes malformed result and does not call service', async () => {
    const checkService = new FakeCheckService();
    const { runner, fake } = await makeReadyRunner({ checkService, volume: 'vol' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_run_checks', id: 'checks-3b', repo: 'owner/repo/extra', kind: 'all' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    const checksResultLine = fake.stdinLines.find((l) => l.includes('checks-3b'));
    expect(checksResultLine).toBeDefined();
    expect(JSON.parse(checksResultLine ?? '{}')).toEqual({
      type: 'run_checks_result',
      id: 'checks-3b',
      ok: false,
      reason: 'malformed request',
    });
    expect(checkService.checks).toHaveLength(0);
  });

  it('no service or volume returns unavailable', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_run_checks', id: 'checks-4', repo: 'owner/repo', kind: 'lint' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'running checks for owner/repo...' });

    const e2Promise = iter.next();
    const checksResultLine = await waitForStdinLine(fake, (l) => l.includes('run_checks_result'));
    expect(checksResultLine).toBeDefined();
    expect(JSON.parse(checksResultLine ?? '{}')).toEqual({
      type: 'run_checks_result',
      id: 'checks-4',
      ok: false,
      reason: 'run_checks unavailable',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    await e2Promise;
  });
});
