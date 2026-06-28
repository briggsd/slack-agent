/**
 * Unit tests for the request_read_issue round-trip through DockerRunner.
 *
 * All offline — no Docker, no network, no Slack.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import { FakeReadIssueService } from '../src/runner/fake-read-issue-service.js';

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
  readIssueService?: FakeReadIssueService;
}): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const config = { ...DEFAULT_CONFIG, ...opts?.config };
  const runner = new DockerRunner(
    fake.asChildProcess(),
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts?.readIssueService,
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

describe('DockerRunner — request_read_issue round-trip', () => {
  it('request_read_issue writes read_issue_result{ok:true, issue} and calls the service', async () => {
    const readIssueService = new FakeReadIssueService();
    readIssueService.setIssue({
      title: 'Bug: login fails',
      body: 'Steps to reproduce the bug...',
      state: 'open',
      author: 'reporter1',
    });
    const { runner, fake } = await makeReadyRunner({ readIssueService });

    const iter = runner.send('read issue')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_read_issue',
      id: 'read-issue-1',
      host: 'github',
      repo: 'owner/repo',
      number: 42,
    }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'reading issue #42 in owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('read_issue_result'));
    const parsedResult = JSON.parse(resultLine ?? '{}') as Record<string, unknown>;
    expect(parsedResult).toEqual({
      type: 'read_issue_result',
      id: 'read-issue-1',
      ok: true,
      issue: {
        title: 'Bug: login fails',
        body: 'Steps to reproduce the bug...',
        state: 'open',
        author: 'reporter1',
      },
    });

    expect(readIssueService.requests).toEqual([{
      host: 'github',
      repo: 'owner/repo',
      number: 42,
    }]);

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await e2Promise).value).toEqual({ type: 'text', text: 'done' });
  });

  it('request_read_issue failure writes read_issue_result{ok:false}', async () => {
    const readIssueService = new FakeReadIssueService();
    readIssueService.setOutcome({ ok: false, reason: 'Not Found' });
    const { runner, fake } = await makeReadyRunner({ readIssueService });

    const iter = runner.send('read issue')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_read_issue',
      id: 'read-issue-2',
      host: 'github',
      repo: 'owner/repo',
      number: 999,
    }));

    expect((await e1Promise).value).toEqual({ type: 'status', text: 'reading issue #999 in owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('read_issue_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'read_issue_result',
      id: 'read-issue-2',
      ok: false,
      reason: 'Not Found',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'reported failure' }));
    expect((await e2Promise).value).toEqual({ type: 'text', text: 'reported failure' });
  });

  it('request_read_issue with no service wired writes unavailable result', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('read issue')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_read_issue',
      id: 'read-issue-3',
      host: 'github',
      repo: 'owner/repo',
      number: 1,
    }));

    expect((await e1Promise).value).toEqual({ type: 'status', text: 'reading issue #1 in owner/repo…' });

    const e2Promise = iter.next();
    const resultLine = await waitForStdinLine(fake, (l) => l.includes('read_issue_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'read_issue_result',
      id: 'read-issue-3',
      ok: false,
      reason: 'read_issue unavailable',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    expect((await e2Promise).value).toEqual({ type: 'text', text: 'done' });
  });

  it('malformed request_read_issue (missing id) is skipped without calling service', async () => {
    const readIssueService = new FakeReadIssueService();
    const { runner, fake } = await makeReadyRunner({ readIssueService });

    const iter = runner.send('read issue')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // No 'id' field — should be skipped
    fake.writeOut(JSON.stringify({ type: 'request_read_issue', host: 'github', repo: 'owner/repo', number: 1 }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    expect((await e1Promise).value).toEqual({ type: 'text', text: 'done' });
    expect(readIssueService.requests).toHaveLength(0);
  });

  it('malformed request_read_issue (invalid host) writes malformed result and does not call service', async () => {
    const readIssueService = new FakeReadIssueService();
    const { runner, fake } = await makeReadyRunner({ readIssueService });

    const iter = runner.send('read issue')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_read_issue',
      id: 'read-issue-bad',
      host: 'bitbucket',
      repo: 'owner/repo',
      number: 1,
    }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    expect((await e1Promise).value).toEqual({ type: 'text', text: 'done' });
    const resultLine = fake.stdinLines.find((l) => l.includes('read_issue_result'));
    expect(JSON.parse(resultLine ?? '{}')).toEqual({
      type: 'read_issue_result',
      id: 'read-issue-bad',
      ok: false,
      reason: 'malformed request',
    });
    expect(readIssueService.requests).toHaveLength(0);
  });
});
