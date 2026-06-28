/**
 * Unit tests for the request_exec <-> exec_result round-trip through DockerRunner.
 *
 * All offline: FakeChildProcess stdio only, no Docker, no Slack, no network.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import type { ExecOutcome } from '../src/runner/types.js';

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
  absoluteTurnTimeoutMs: 30 * 60_000,
  killGraceMs: 100,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

async function makeReadyRunner(): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(fake.asChildProcess(), DEFAULT_CONFIG);
  const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;
  return { runner, fake };
}

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

describe('DockerRunner — request_exec round-trip', () => {
  it('request_exec yields run_exec and writes ok exec_result from ExecOutcome', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner.send('exec owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_exec',
      id: 'exec-1',
      host: 'github',
      repo: 'owner/repo',
      instruction: 'ship it',
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({
      type: 'run_exec',
      host: 'github',
      repo: 'owner/repo',
      instruction: 'ship it',
    });

    const outcome: ExecOutcome = { ok: true, prUrl: 'https://github.com/owner/repo/pull/1' };
    const e2Promise = iter.next(outcome);

    const execResultLine = await waitForStdinLine(fake, (l) => l.includes('exec_result'));
    expect(execResultLine).toBeDefined();
    expect(JSON.parse(execResultLine ?? '{}')).toEqual({
      type: 'exec_result',
      id: 'exec-1',
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
  });

  it('malformed request_exec writes malformed exec_result and does not yield run_exec', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner.send('exec')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_exec', id: 'exec-2', host: 'github', repo: 'owner/repo' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });
    const execResultLine = fake.stdinLines.find((l) => l.includes('exec_result'));
    expect(execResultLine).toBeDefined();
    expect(JSON.parse(execResultLine ?? '{}')).toEqual({
      type: 'exec_result',
      id: 'exec-2',
      ok: false,
      reason: 'malformed request',
    });
  });
});
