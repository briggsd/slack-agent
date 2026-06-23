/**
 * Unit tests for the request_pr_edit/request_pr_comment round-trips through DockerRunner.
 *
 * All offline — no Docker, no network, no Slack.
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

describe('DockerRunner — request_pr_edit/request_pr_comment round-trip', () => {
  it('request_pr_edit writes pr_edit_result{ok:true}, calls the service, and yields pr_edited', async () => {
    const publishService = new FakePublishService();
    publishService.setEditOutcome({ ok: true, prUrl: 'https://github.com/owner/repo/pull/5' });
    const { runner, fake } = await makeReadyRunner({
      publishService,
      volume: 'slackbot-ws-edit',
      config: { now: scriptedNow(200, 245) },
    });

    const iter = runner.send('edit it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_pr_edit',
      id: 'pr-edit-1',
      repo: 'owner/repo',
      title: 'Updated title',
      body: 'Updated body',
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'editing PR for owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('pr_edit_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'pr_edit_result',
      id: 'pr-edit-1',
      ok: true,
    });
    expect(publishService.prEdits).toEqual([{
      repo: 'owner/repo',
      volume: 'slackbot-ws-edit',
      title: 'Updated title',
      body: 'Updated body',
    }]);

    const e2 = await e2Promise;
    expect(e2.value).toEqual({
      type: 'pr_edited',
      url: 'https://github.com/owner/repo/pull/5',
      elapsedMs: 45,
    });

    const e3Promise = iter.next();
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await e3Promise).value).toEqual({ type: 'text', text: 'done' });
  });

  it('request_pr_edit failure writes pr_edit_result{ok:false} and yields no event', async () => {
    const publishService = new FakePublishService();
    publishService.setEditOutcome({ ok: false, reason: 'edit PR failed' });
    const { runner, fake } = await makeReadyRunner({ publishService, volume: 'vol' });

    const iter = runner.send('edit it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_pr_edit', id: 'pr-edit-2', repo: 'owner/repo' }));
    expect((await e1Promise).value).toEqual({ type: 'status', text: 'editing PR for owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('pr_edit_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'pr_edit_result',
      id: 'pr-edit-2',
      ok: false,
      reason: 'edit PR failed',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'reported failure' }));
    expect((await e2Promise).value).toEqual({ type: 'text', text: 'reported failure' });
  });

  it('request_pr_comment writes pr_comment_result{ok:true}, calls the service, and yields pr_commented', async () => {
    const publishService = new FakePublishService();
    publishService.setCommentOutcome({ ok: true, prUrl: 'https://github.com/owner/repo/pull/6' });
    const { runner, fake } = await makeReadyRunner({
      publishService,
      volume: 'slackbot-ws-comment',
      config: { now: scriptedNow(300, 360) },
    });

    const iter = runner.send('comment it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_pr_comment',
      id: 'pr-comment-1',
      repo: 'owner/repo',
      comment: 'Please re-run checks.',
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'commenting on PR for owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('pr_comment_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'pr_comment_result',
      id: 'pr-comment-1',
      ok: true,
    });
    expect(publishService.prComments).toEqual([{
      repo: 'owner/repo',
      volume: 'slackbot-ws-comment',
      comment: 'Please re-run checks.',
    }]);

    const e2 = await e2Promise;
    expect(e2.value).toEqual({
      type: 'pr_commented',
      url: 'https://github.com/owner/repo/pull/6',
      elapsedMs: 60,
    });

    const e3Promise = iter.next();
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await e3Promise).value).toEqual({ type: 'text', text: 'done' });
  });

  it('malformed request_pr_comment writes malformed result and does not call the service', async () => {
    const publishService = new FakePublishService();
    const { runner, fake } = await makeReadyRunner({ publishService, volume: 'vol' });

    const iter = runner.send('comment it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_pr_comment', id: 'pr-comment-2', repo: 'owner/repo', comment: '' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    expect((await e1Promise).value).toEqual({ type: 'text', text: 'done' });
    const resultLine = fake.stdinLines.find((l) => l.includes('pr_comment_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'pr_comment_result',
      id: 'pr-comment-2',
      ok: false,
      reason: 'malformed request',
    });
    expect(publishService.prComments).toHaveLength(0);
  });
});
