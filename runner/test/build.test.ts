/**
 * Unit tests for container-side BuildCoordinator (runner/src/build.ts).
 *
 * Pure and deterministic — no SDK, no stdio, no Docker.
 */

import { describe, it, expect } from 'vitest';
import { BuildCoordinator } from '../src/build.js';
import type { BuildOutcome } from '../src/build.js';
import type { BuildResultMessage } from '../src/protocol.js';

// ── BuildCoordinator ─────────────────────────────────────────────────────────

describe('BuildCoordinator', () => {
  it('emits request_build with id build-1 and parks the promise until the matching result arrives', async () => {
    const emitted: Array<{ repo: string; id: string }> = [];
    const c = new BuildCoordinator((repo, id) => emitted.push({ repo, id }));

    const p = c.requestBuild('owner/repo');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.repo).toBe('owner/repo');
    const id = emitted[0]?.id ?? '';
    expect(id).toBe('build-1');
    expect(id).toMatch(/^build-/);

    // Not resolved yet — still pending
    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Deliver the result
    const msg: BuildResultMessage = { type: 'build_result', id, ok: true, prUrl: 'https://github.com/owner/repo/pull/1' };
    expect(c.handleResult(msg)).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/1' });
  });

  it('handleResult with ok:false resolves with the reason', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p = c.requestBuild('owner/repo');

    const msg: BuildResultMessage = { type: 'build_result', id: ids[0] ?? '', ok: false, reason: 'tests failed' };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: false, reason: 'tests failed' });
  });

  it('ok:true without prUrl falls back to empty string', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p = c.requestBuild('owner/repo');

    // ok:true but no prUrl (gateway sends a minimal result)
    const msg: BuildResultMessage = { type: 'build_result', id: ids[0] ?? '', ok: true };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: true, prUrl: '' });
  });

  it('ok:false without reason falls back to "build failed"', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p = c.requestBuild('owner/repo');

    const msg: BuildResultMessage = { type: 'build_result', id: ids[0] ?? '', ok: false };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: false, reason: 'build failed' });
  });

  it('unknown id returns false (ignored)', () => {
    const c = new BuildCoordinator(() => undefined);
    const msg: BuildResultMessage = { type: 'build_result', id: 'build-999', ok: true, prUrl: 'https://github.com/x/y/pull/1' };
    expect(c.handleResult(msg)).toBe(false);
  });

  it('already-settled id returns false (duplicate delivery is a no-op)', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p = c.requestBuild('owner/repo');
    const id = ids[0] ?? '';

    const msg: BuildResultMessage = { type: 'build_result', id, ok: true, prUrl: 'https://github.com/owner/repo/pull/1' };
    expect(c.handleResult(msg)).toBe(true);
    expect(c.handleResult(msg)).toBe(false); // duplicate — already settled
    await expect(p).resolves.toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/1' });
  });

  it('failAllPending resolves every pending build as ok:false+shutting down', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p1 = c.requestBuild('owner/repo1');
    const p2 = c.requestBuild('owner/repo2');

    c.failAllPending();
    await expect(p1).resolves.toEqual({ ok: false, reason: 'shutting down' });
    await expect(p2).resolves.toEqual({ ok: false, reason: 'shutting down' });
  });

  it('after draining, requestBuild resolves immediately and emits nothing', async () => {
    const emitted: string[] = [];
    const c = new BuildCoordinator((_repo, id) => emitted.push(id));
    c.failAllPending(); // stdin closed

    const p = c.requestBuild('owner/repo');
    await expect(p).resolves.toEqual({ ok: false, reason: 'shutting down' });
    expect(emitted).toHaveLength(0); // no request_build emitted that nobody could answer
  });

  it('concurrent builds get distinct ids and resolve independently', async () => {
    const ids: string[] = [];
    const c = new BuildCoordinator((_repo, id) => ids.push(id));
    const p1 = c.requestBuild('owner/repo1');
    const p2 = c.requestBuild('owner/repo2');
    expect(ids[0]).not.toBe(ids[1]);

    const [id1, id2] = ids as [string, string];
    c.handleResult({ type: 'build_result', id: id2, ok: false, reason: 'compile error' });
    c.handleResult({ type: 'build_result', id: id1, ok: true, prUrl: 'https://github.com/owner/repo1/pull/1' });

    await expect(p1).resolves.toEqual({ ok: true, prUrl: 'https://github.com/owner/repo1/pull/1' });
    await expect(p2).resolves.toEqual({ ok: false, reason: 'compile error' });
  });

  it('sequential requestBuild calls use incrementing ids (build-1, build-2, ...)', async () => {
    const emitted: Array<{ repo: string; id: string }> = [];
    const c = new BuildCoordinator((repo, id) => emitted.push({ repo, id }));

    const p1 = c.requestBuild('owner/repo1');
    const p2 = c.requestBuild('owner/repo2');

    expect(emitted[0]?.id).toBe('build-1');
    expect(emitted[1]?.id).toBe('build-2');

    // Resolve both
    c.handleResult({ type: 'build_result', id: 'build-1', ok: true, prUrl: 'https://pr/1' });
    c.handleResult({ type: 'build_result', id: 'build-2', ok: false, reason: 'failed' });

    const o1 = await p1 as BuildOutcome;
    const o2 = await p2 as BuildOutcome;
    expect(o1.ok).toBe(true);
    expect(o2.ok).toBe(false);
  });
});
