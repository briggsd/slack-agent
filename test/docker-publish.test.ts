/**
 * Unit tests for the request_publish ↔ publish_result round-trip through DockerRunner.
 *
 * Reuses the same fake process pattern as docker-clone.test.ts. All offline — no Docker,
 * no network, no Slack.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import { FakePublishService } from '../src/runner/fake-publish-service.js';

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
  simulateExit(code: number | null = 0): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
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
  config?: Partial<DockerRunnerConfig>;
  publishService?: FakePublishService;
  volume?: string;
}): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const config = { ...DEFAULT_CONFIG, ...opts?.config };
  const runner = new DockerRunner(
    fake.asChildProcess(),
    config,
    undefined,
    undefined,
    opts?.volume,
    opts?.publishService,
  );
  const readyPromise = DockerRunner.waitReady(runner, config.readyTimeoutMs);
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

function scriptedNow(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1]!;
}

describe('DockerRunner — request_publish round-trip', () => {
  it('request_publish → status + publish_result{ok:true} + pr_opened when publishService returns ok', async () => {
    const publishService = new FakePublishService();
    publishService.setOutcome({
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 17,
      headSha: 'publish-head-sha',
    });
    const { runner, fake } = await makeReadyRunner({
      publishService,
      volume: 'slackbot-ws-test',
      // Two extra leading values for the new turnStart + loop-head now() calls added
      // by the inactivity-timer rework. serviceDispatch still sees 100 and 145.
      config: { now: scriptedNow(0, 0, 100, 145) },
    });

    const iter = runner.send('publish it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_publish',
      id: 'publish-1',
      repo: 'owner/repo',
      title: 'Ship verified work',
      body: 'Verified body',
      correlationId: 'build-77',
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'publishing owner/repo…' });

    const e2Promise = iter.next();
    const publishResultLine = await waitForStdinLine(fake, (l) => l.includes('publish_result'));
    expect(publishResultLine).toBeDefined();
    expect(JSON.parse(publishResultLine ?? '{}')).toEqual({
      type: 'publish_result',
      id: 'publish-1',
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    expect(fake.stdinLines.filter((l) => l.includes('publish_result'))).toHaveLength(1);
    expect(publishService.publishes).toEqual([{
      repo: 'owner/repo',
      volume: 'slackbot-ws-test',
      title: 'Ship verified work',
      body: 'Verified body',
    }]);

    const e2 = await e2Promise;
    expect(e2.value).toEqual({
      type: 'pr_opened',
      url: 'https://github.com/owner/repo/pull/1',
      repo: 'owner/repo',
      number: 17,
      headSha: 'publish-head-sha',
      correlationId: 'build-77',
      elapsedMs: 45,
    });

    const e3Promise = iter.next();
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e3 = await e3Promise;
    expect(e3.value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });

  it('request_publish with publishService returning ok:false writes publish_result{ok:false}', async () => {
    const publishService = new FakePublishService();
    publishService.setOutcome({ ok: false, reason: 'push failed' });
    const { runner, fake } = await makeReadyRunner({ publishService, volume: 'vol' });

    const iter = runner.send('publish it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_publish', id: 'publish-2', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'publishing owner/repo…' });

    const e2Promise = iter.next();
    const publishResultLine = await waitForStdinLine(fake, (l) => l.includes('publish_result'));
    expect(publishResultLine).toBeDefined();
    expect(JSON.parse(publishResultLine ?? '{}')).toEqual({
      type: 'publish_result',
      id: 'publish-2',
      ok: false,
      reason: 'push failed',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'reported failure' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'reported failure' });
    expect((await iter.next()).done).toBe(true);
  });

  it('no publishService wired → publish_result{ok:false, reason:"publish unavailable"}', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('publish it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_publish', id: 'publish-3', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'publishing owner/repo…' });

    const e2Promise = iter.next();
    const publishResultLine = await waitForStdinLine(fake, (l) => l.includes('publish_result'));
    expect(publishResultLine).toBeDefined();
    expect(JSON.parse(publishResultLine ?? '{}')).toEqual({
      type: 'publish_result',
      id: 'publish-3',
      ok: false,
      reason: 'publish unavailable',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'ok' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'ok' });
    expect((await iter.next()).done).toBe(true);
  });

  it('malformed request_publish (has id but no repo) writes malformed result and does not call service', async () => {
    const publishService = new FakePublishService();
    const { runner, fake } = await makeReadyRunner({ publishService, volume: 'vol' });

    const iter = runner.send('publish it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_publish', id: 'publish-4' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    const publishResultLine = fake.stdinLines.find((l) => l.includes('publish_result'));
    expect(publishResultLine).toBeDefined();
    expect(JSON.parse(publishResultLine ?? '{}')).toEqual({
      type: 'publish_result',
      id: 'publish-4',
      ok: false,
      reason: 'malformed request',
    });
    expect(publishService.publishes).toHaveLength(0);
  });

  it('malformed request_publish (non-string body) writes malformed result and does not call service', async () => {
    const publishService = new FakePublishService();
    const { runner, fake } = await makeReadyRunner({ publishService, volume: 'vol' });

    const iter = runner.send('publish it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_publish', id: 'publish-5', repo: 'owner/repo', body: { nope: true } }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    const publishResultLine = fake.stdinLines.find((l) => l.includes('publish_result'));
    expect(publishResultLine).toBeDefined();
    expect(JSON.parse(publishResultLine ?? '{}')).toMatchObject({
      type: 'publish_result',
      id: 'publish-5',
      ok: false,
      reason: 'malformed request',
    });
    expect(publishService.publishes).toHaveLength(0);
  });
});
