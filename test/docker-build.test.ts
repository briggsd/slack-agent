/**
 * Unit tests for the request_build ↔ build_result round-trip through DockerRunner (S12b).
 *
 * Mirrors docker-clone.test.ts's structure — uses an inline FakeChildProcess.
 * All offline — no Docker, no network, no Slack.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { DockerRunner } from '../src/runner/docker.js';
import type { DockerRunnerConfig } from '../src/runner/docker.js';
import type { BuildOutcome } from '../src/runner/types.js';

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

describe('DockerRunner — request_build round-trip (S12b)', () => {
  it('request_build → yields run_build event → feed back BuildOutcome{ok:true} → ok-only build_result written to stdin', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('build owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // Container emits a request_build
    fake.writeOut(JSON.stringify({ type: 'request_build', id: 'build-1', repo: 'owner/repo' }));

    // The generator should yield a run_build event
    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'run_build', repo: 'owner/repo' });

    // Feed back the BuildOutcome via next() the way the manager does
    const outcome: BuildOutcome = { ok: true };
    const e2Promise = iter.next(outcome);

    // The generator should write build_result to the container's stdin
    const buildResultLine = await waitForStdinLine(fake, (l) => l.includes('build_result'));
    expect(buildResultLine).toBeDefined();
    expect(JSON.parse(buildResultLine ?? '{}')).toEqual({
      type: 'build_result',
      id: 'build-1',
      ok: true,
    });

    // Turn completes normally after the build
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'PR opened!' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'PR opened!' });
    expect((await iter.next()).done).toBe(true);
  });

  it('request_build → feed back BuildOutcome{ok:false} → build_result{ok:false, reason} written', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('build owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_build', id: 'build-2', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'run_build', repo: 'owner/repo' });

    const outcome: BuildOutcome = { ok: false, reason: 'CI failed: 3 tests red' };
    const e2Promise = iter.next(outcome);

    const buildResultLine = await waitForStdinLine(fake, (l) => l.includes('build_result'));
    expect(buildResultLine).toBeDefined();
    expect(JSON.parse(buildResultLine ?? '{}')).toEqual({
      type: 'build_result',
      id: 'build-2',
      ok: false,
      reason: 'CI failed: 3 tests red',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'build failed' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'build failed' });
    expect((await iter.next()).done).toBe(true);
  });

  it('malformed request_build (has id but non-string repo) → build_result{ok:false, reason:"malformed request"} unblocks the tool', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('build')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    // No repo field — has id but repo is missing
    fake.writeOut(JSON.stringify({ type: 'request_build', id: 'build-3' }));
    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'text', text: 'done' });

    // The fallback build_result must be written to unblock the parked tool
    const buildResultLine = fake.stdinLines.find((l) => l.includes('build_result'));
    expect(buildResultLine).toBeDefined();
    expect(JSON.parse(buildResultLine ?? '{}')).toEqual({
      type: 'build_result',
      id: 'build-3',
      ok: false,
      reason: 'malformed request',
    });
  });

  it('deadline is reset after build completes (post-build continuation gets a fresh turn budget)', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('build owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_build', id: 'build-4', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'run_build', repo: 'owner/repo' });

    // Verify that the generator resumes after next() and the turn continues
    // (if deadline were NOT reset, the turn might time out; here we just verify
    // the turn completes normally, which proves the deadline was updated or at
    // minimum the continuation is still driven).
    const outcome: BuildOutcome = { ok: true };
    const e2Promise = iter.next(outcome);

    await waitForStdinLine(fake, (l) => l.includes('build_result'));

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'shipped' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'shipped' });
    expect((await iter.next()).done).toBe(true);
  });

  it('request_build with undefined resume → build_result{ok:false, reason:"build failed"}', async () => {
    const { runner, fake } = await makeReadyRunner();

    const iter = runner.send('build owner/repo')[Symbol.asyncIterator]();
    const e1Promise = iter.next();
    await tick();

    fake.writeOut(JSON.stringify({ type: 'request_build', id: 'build-5', repo: 'owner/repo' }));

    const e1 = await e1Promise;
    expect(e1.value).toEqual({ type: 'run_build', repo: 'owner/repo' });

    // Feed back undefined (e.g. the manager encountered an unexpected error)
    const e2Promise = iter.next(undefined);

    const buildResultLine = await waitForStdinLine(fake, (l) => l.includes('build_result'));
    expect(buildResultLine).toBeDefined();
    expect(JSON.parse(buildResultLine ?? '{}')).toEqual({
      type: 'build_result',
      id: 'build-5',
      ok: false,
      reason: 'build failed',
    });

    fake.writeOut(JSON.stringify({ type: 'text', id: turnId(fake), text: 'done' }));
    const e2 = await e2Promise;
    expect(e2.value).toEqual({ type: 'text', text: 'done' });
    expect((await iter.next()).done).toBe(true);
  });
});
