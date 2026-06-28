/**
 * Unit tests for the request_clone ↔ clone_result round-trip through DockerRunner (S11).
 *
 * Reuses FakeChildProcess from docker.test.ts (via inline definition to stay self-contained).
 * All offline — no Docker, no network, no Slack.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import { FakeCloneService } from '../src/runner/fake-clone-service.js';

// ── FakeChildProcess (local copy) ─────────────────────────────────────────────

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
  writeErr(line: string): void { this.stderr.push(line + '\n'); }
  simulateExit(code: number | null = 0): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
  asChildProcess(): ChildProcess { return this as unknown as ChildProcess; }
  kill(): boolean { return true; }
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

async function makeReadyRunner(opts?: {
  cloneService?: FakeCloneService;
  volume?: string;
}): Promise<{ runner: DockerRunner; fake: FakeChildProcess }> {
  const fake = new FakeChildProcess();
  const runner = new DockerRunner(
    fake.asChildProcess(),
    DEFAULT_CONFIG,
    undefined,
    opts?.cloneService,
    opts?.volume,
  );
  const readyPromise = DockerRunner.waitReady(runner, DEFAULT_CONFIG.readyTimeoutMs);
  fake.writeOut(JSON.stringify({ type: 'ready' }));
  await readyPromise;
  return { runner, fake };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** Wait until fake.stdinLines contains a line matching the predicate, or timeout. */
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DockerRunner — request_clone round-trip (S11)', () => {
  it('request_clone → status + clone_result{ok:true} written back when cloneService returns ok', async () => {
    const cloneService = new FakeCloneService();
    cloneService.setOutcome({ ok: true, workdir: '/workspace/owner-repo' });
    const { runner, fake } = await makeReadyRunner({ cloneService, volume: 'slackbot-ws-test' });

    const iter = runner.send('investigate owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // Container emits a request_clone
    fake.writeOut(JSON.stringify({ type: 'request_clone', id: 'clone-1', repo: 'owner/repo' }));

    // Should yield a status event showing progress
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'cloning owner/repo…' });

    // Resume the generator (it paused at the status yield) so it can call cloneService.clone()
    // and write clone_result back to the container. We do both concurrently: the generator runs
    // the clone while the test polls stdinLines for the result.
    const e2Promise = iter.next();
    const cloneResultLine = await waitForStdinLine(fake, (l) => l.includes('clone_result'));
    expect(cloneResultLine).toBeDefined();
    expect(JSON.parse(cloneResultLine ?? '{}')).toEqual({
      type: 'clone_result',
      id: 'clone-1',
      ok: true,
      workdir: '/workspace/owner-repo',
    });

    // Turn completes normally
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });

  it('request_clone with cloneService returning ok:false writes clone_result{ok:false}', async () => {
    const cloneService = new FakeCloneService();
    cloneService.setOutcome({ ok: false, error: 'auth failed' });
    const { runner, fake } = await makeReadyRunner({ cloneService, volume: 'vol' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_clone', id: 'clone-2', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'cloning owner/repo…' });

    // Resume the generator (it paused at yield) and let the container write the text response.
    // The generator runs: cloneService.clone() → write clone_result → continue → nextLineWithTimeout.
    const e2Promise = iter.next();
    const cloneResultLine = await waitForStdinLine(fake, (l) => l.includes('clone_result'));
    expect(cloneResultLine).toBeDefined();
    expect(JSON.parse(cloneResultLine ?? '{}')).toEqual({
      type: 'clone_result',
      id: 'clone-2',
      ok: false,
      error: 'auth failed',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'clone failed, trying another approach' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'clone failed, trying another approach' });
  });

  it('no cloneService wired → clone_result{ok:false, error:"clone unavailable"}', async () => {
    // No cloneService passed
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_clone', id: 'clone-3', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'status', text: 'cloning owner/repo…' });

    // Resume the generator to let it write the clone_result and advance past the yield.
    const e2Promise = iter.next();
    const cloneResultLine = await waitForStdinLine(fake, (l) => l.includes('clone_result'));
    expect(cloneResultLine).toBeDefined();
    expect(JSON.parse(cloneResultLine ?? '{}')).toEqual({
      type: 'clone_result',
      id: 'clone-3',
      ok: false,
      error: 'clone unavailable',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'ok' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'ok' });
  });

  it('malformed request_clone (has id but no repo) → clone_result{ok:false, error:"malformed request"} unblocks the tool', async () => {
    const cloneService = new FakeCloneService();
    const { runner, fake } = await makeReadyRunner({ cloneService, volume: 'vol' });

    const iter = runner.send('check it')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // No repo field
    fake.writeOut(JSON.stringify({ type: 'request_clone', id: 'clone-4' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    // The fallback clone_result must be written to unblock the parked tool
    const cloneResultLine = fake.stdinLines.find((l) => l.includes('clone_result'));
    expect(cloneResultLine).toBeDefined();
    expect(JSON.parse(cloneResultLine ?? '{}')).toEqual({
      type: 'clone_result',
      id: 'clone-4',
      ok: false,
      error: 'malformed request',
    });

    // Clone service not called since repo was absent
    expect(cloneService.clones).toHaveLength(0);
  });
});

describe('DockerRunner — carry-forward fix for malformed request_approval (S11)', () => {
  it('a malformed request_approval (has id, missing specRef) is skipped without writing approval_verdict', async () => {
    const { runner, fake } = await makeReadyRunner();
    const iter = runner.send('build')[Symbol.asyncIterator]();

    const e1Promise = iter.next();
    await tick();

    // Has id but no specRef
    fake.writeOut(JSON.stringify({ type: 'request_approval', id: 'appr-x' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    expect(fake.stdinLines.some((l) => l.includes('approval_verdict'))).toBe(false);
  });
});
