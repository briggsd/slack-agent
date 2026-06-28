/**
 * Unit tests for the request_provision ↔ provision_result round-trip through DockerRunner.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import { FakeRuntimeProvisionService } from '../src/runner/fake-runtime-provision-service.js';

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

  writeOut(line: string): void { this.stdout.push(`${line}\n`); }
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

async function makeReadyRunner(opts?: {
  runtimeProvisionService?: FakeRuntimeProvisionService;
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
    undefined,
    opts?.runtimeProvisionService,
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

describe('DockerRunner — request_provision round-trip', () => {
  it('request_provision → status + provision_result{ok:true} written back', async () => {
    const runtimeProvisionService = new FakeRuntimeProvisionService();
    const { runner, fake } = await makeReadyRunner({ runtimeProvisionService, volume: 'slackbot-ws-test' });

    const iter = runner.send('need python')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_provision', id: 'provision-1', name: 'python' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'provisioning runtime python...' });

    const e2Promise = iter.next();
    const provisionResultLine = await waitForStdinLine(fake, (l) => l.includes('provision_result'));
    expect(provisionResultLine).toBeDefined();
    expect(JSON.parse(provisionResultLine ?? '{}')).toEqual({
      type: 'provision_result',
      id: 'provision-1',
      ok: true,
    });
    expect(runtimeProvisionService.provisions).toEqual([{ name: 'python', volume: 'slackbot-ws-test' }]);

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
  });

  it('service refusal writes provision_result{ok:false}', async () => {
    const runtimeProvisionService = new FakeRuntimeProvisionService();
    runtimeProvisionService.setOutcome({ ok: false, error: 'runtime not available' });
    const { runner, fake } = await makeReadyRunner({ runtimeProvisionService, volume: 'vol' });

    const iter = runner.send('need ruby')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_provision', id: 'provision-2', name: 'ruby' }));
    await e1Promise;

    const e2Promise = iter.next();
    const provisionResultLine = await waitForStdinLine(fake, (l) => l.includes('provision_result'));
    expect(JSON.parse(provisionResultLine ?? '{}')).toEqual({
      type: 'provision_result',
      id: 'provision-2',
      ok: false,
      error: 'runtime not available',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    await e2Promise;
  });

  it('malformed request_provision missing id is skipped and does not call service', async () => {
    const runtimeProvisionService = new FakeRuntimeProvisionService();
    const { runner, fake } = await makeReadyRunner({ runtimeProvisionService, volume: 'vol' });

    const iter = runner.send('need runtime')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_provision', name: 'python' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });
    expect(fake.stdinLines.some((line) => line.includes('provision_result'))).toBe(false);
    expect(runtimeProvisionService.provisions).toHaveLength(0);
  });

  it('malformed request_provision with id writes malformed result and does not call service', async () => {
    const runtimeProvisionService = new FakeRuntimeProvisionService();
    const { runner, fake } = await makeReadyRunner({ runtimeProvisionService, volume: 'vol' });

    const iter = runner.send('need runtime')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_provision', id: 'provision-3', name: 42 }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });
    const provisionResultLine = fake.stdinLines.find((line) => line.includes('provision-3'));
    expect(JSON.parse(provisionResultLine ?? '{}')).toEqual({
      type: 'provision_result',
      id: 'provision-3',
      ok: false,
      error: 'malformed request',
    });
    expect(runtimeProvisionService.provisions).toHaveLength(0);
  });
});
