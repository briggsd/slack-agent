/**
 * Tests for the shared serviceDispatch helper behavior in DockerRunner.
 *
 * Covers two paths that the per-tool round-trip suites don't all verify
 * independently:
 *   (a) A service-call request missing `id` is logged and skipped — no
 *       result written, loop continues normally.
 *   (b) When stdin becomes non-writable between the service call and the
 *       result write, the runner yields runner_error and terminates (the
 *       `'fatal'` path).
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

describe('DockerRunner — serviceDispatch helper behavior', () => {
  it('(a) request_provision missing id is skipped: no result written and the loop continues', async () => {
    // Use provision as a representative service-call type to test the missing-id path.
    // The loop must continue and eventually deliver the text event (not terminate).
    const { runner, fake } = await makeReadyRunner({ volume: 'vol' });

    const iter = runner.send('do something')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // Send a request_provision WITHOUT an id — this should be logged and skipped.
    fake.writeOut(JSON.stringify({ type: 'request_provision', name: 'python' }));
    // Then send the normal turn-ending text.
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'still running' }));

    // The first yielded event should be the text (skip produced no event or result write).
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'still running' });

    // No provision_result should have been written to stdin.
    expect(fake.stdinLines.some((l) => l.includes('provision_result'))).toBe(false);

    expect((await iter.next()).done).toBe(true);
  });

  it('(b) stdin becomes non-writable after the service call: yields runner_error and terminates', async () => {
    // Use pr_edit as the service-call type (mirrors docker-edit-comment-pr.test.ts harness).
    // The publish service returns a result, but by then stdin has been destroyed — the
    // fatal path must yield runner_error and return.
    const publishService = new FakePublishService();
    publishService.setEditOutcome({ ok: true, prUrl: 'https://github.com/owner/repo/pull/5' });

    // Override invoke so we can destroy stdin between the service call and the result write.
    let fakeRef: FakeChildProcess | undefined;
    const wrappedService = new FakePublishService();
    wrappedService.setEditOutcome({ ok: true, prUrl: 'https://github.com/owner/repo/pull/5' });

    const { runner, fake } = await makeReadyRunner({
      publishService: wrappedService,
      volume: 'slackbot-ws-edit',
    });
    fakeRef = fake;

    // Intercept the editPr call so we destroy stdin BEFORE the promise resolves.
    const origEditPr = wrappedService.editPr.bind(wrappedService);
    wrappedService.editPr = async (req) => {
      // Destroy stdin while the service "runs" — simulates a container crash between
      // the await and the write.
      fakeRef?.stdin.destroy();
      return origEditPr(req);
    };

    const iter = runner.send('edit it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({
      type: 'request_pr_edit',
      id: 'pr-edit-fatal',
      repo: 'owner/repo',
    }));

    // First event: the status yielded before the service call.
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'editing PR for owner/repo…' });

    // Second event: runner_error from the fatal path (stdin not writable after service call).
    const e2 = await iter.next();
    expect(e2.value).toEqual({
      type: 'error',
      message: 'runner stdin is not writable',
      reason: 'runner_error',
    });

    // The stream must terminate after the fatal error.
    expect((await iter.next()).done).toBe(true);

    // No pr_edit_result should have been written (stdin was gone).
    expect(fake.stdinLines.some((l) => l.includes('pr_edit_result'))).toBe(false);
  });
});
