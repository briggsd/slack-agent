/**
 * Unit tests for container-side CloneCoordinator (runner/src/clone.ts)
 * and the parseInbound clone_result case (runner/src/approval.ts).
 *
 * Pure and deterministic — no SDK, no stdio, no Docker.
 */

import { describe, it, expect } from 'vitest';
import { CloneCoordinator } from '../src/clone.js';
import type { CloneOutcome } from '../src/clone.js';
import { parseInbound } from '../src/approval.js';
import type { CloneResultMessage } from '../src/protocol.js';

// ── CloneCoordinator ─────────────────────────────────────────────────────────

describe('CloneCoordinator', () => {
  it('emits request_clone and parks the promise until the matching result arrives', async () => {
    const emitted: Array<{ repo: string; id: string }> = [];
    const c = new CloneCoordinator((repo, id) => emitted.push({ repo, id }));

    const p = c.requestClone('owner/repo');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.repo).toBe('owner/repo');
    const id = emitted[0]?.id ?? '';
    expect(id).toMatch(/^clone-/);

    // Not resolved yet — still pending
    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Deliver the result
    const msg: CloneResultMessage = { type: 'clone_result', id, ok: true, workdir: '/workspace/owner-repo' };
    expect(c.handleResult(msg)).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, workdir: '/workspace/owner-repo' });
  });

  it('handleResult with ok:false resolves with the error', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p = c.requestClone('owner/repo');

    const msg: CloneResultMessage = { type: 'clone_result', id: ids[0] ?? '', ok: false, error: 'auth failed' };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: false, error: 'auth failed' });
  });

  it('ok:true without workdir falls back to /workspace', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p = c.requestClone('owner/repo');

    // ok:true but no workdir (gateway sends a minimal result)
    const msg: CloneResultMessage = { type: 'clone_result', id: ids[0] ?? '', ok: true };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: true, workdir: '/workspace' });
  });

  it('ok:false without error falls back to "clone failed"', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p = c.requestClone('owner/repo');

    const msg: CloneResultMessage = { type: 'clone_result', id: ids[0] ?? '', ok: false };
    c.handleResult(msg);
    await expect(p).resolves.toEqual({ ok: false, error: 'clone failed' });
  });

  it('unknown id returns false (ignored)', () => {
    const c = new CloneCoordinator(() => undefined);
    const msg: CloneResultMessage = { type: 'clone_result', id: 'clone-999', ok: true, workdir: '/w' };
    expect(c.handleResult(msg)).toBe(false);
  });

  it('already-settled id returns false (duplicate delivery is a no-op)', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p = c.requestClone('owner/repo');
    const id = ids[0] ?? '';

    const msg: CloneResultMessage = { type: 'clone_result', id, ok: true, workdir: '/w' };
    expect(c.handleResult(msg)).toBe(true);
    expect(c.handleResult(msg)).toBe(false); // duplicate — already settled
    await expect(p).resolves.toEqual({ ok: true, workdir: '/w' });
  });

  it('failAllPending resolves every pending clone as ok:false+shutting down', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p1 = c.requestClone('owner/repo1');
    const p2 = c.requestClone('owner/repo2');

    c.failAllPending();
    await expect(p1).resolves.toEqual({ ok: false, error: 'shutting down' });
    await expect(p2).resolves.toEqual({ ok: false, error: 'shutting down' });
  });

  it('after draining, requestClone resolves immediately and emits nothing', async () => {
    const emitted: string[] = [];
    const c = new CloneCoordinator((_repo, id) => emitted.push(id));
    c.failAllPending(); // stdin closed

    const p = c.requestClone('owner/repo');
    await expect(p).resolves.toEqual({ ok: false, error: 'shutting down' });
    expect(emitted).toHaveLength(0); // no request_clone emitted that nobody could answer
  });

  it('concurrent clones get distinct ids and resolve independently', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p1 = c.requestClone('owner/repo1');
    const p2 = c.requestClone('owner/repo2');
    expect(ids[0]).not.toBe(ids[1]);

    const [id1, id2] = ids as [string, string];
    c.handleResult({ type: 'clone_result', id: id2, ok: false, error: 'net' });
    c.handleResult({ type: 'clone_result', id: id1, ok: true, workdir: '/workspace/owner-repo1' });

    await expect(p1).resolves.toEqual({ ok: true, workdir: '/workspace/owner-repo1' });
    await expect(p2).resolves.toEqual({ ok: false, error: 'net' });
  });
});

// ── parseInbound — clone_result case ─────────────────────────────────────────

describe('parseInbound — clone_result', () => {
  it('parses a well-formed clone_result with ok:true and workdir', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'clone_result', id: 'clone-1', ok: true, workdir: '/workspace/owner-repo' }),
    );
    expect(result).toEqual({
      kind: 'clone_result',
      msg: { type: 'clone_result', id: 'clone-1', ok: true, workdir: '/workspace/owner-repo' },
    });
  });

  it('parses a well-formed clone_result with ok:false and error', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'clone_result', id: 'clone-2', ok: false, error: 'auth failed' }),
    );
    expect(result).toEqual({
      kind: 'clone_result',
      msg: { type: 'clone_result', id: 'clone-2', ok: false, error: 'auth failed' },
    });
  });

  it('parses ok:true without workdir (workdir absent in parsed msg)', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'clone_result', id: 'clone-3', ok: true }),
    );
    expect(result.kind).toBe('clone_result');
    if (result.kind === 'clone_result') {
      expect(result.msg.ok).toBe(true);
      expect(result.msg.id).toBe('clone-3');
      expect('workdir' in result.msg).toBe(false);
    }
  });

  it('parses ok:false without error (error absent in parsed msg)', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'clone_result', id: 'clone-4', ok: false }),
    );
    expect(result.kind).toBe('clone_result');
    if (result.kind === 'clone_result') {
      expect(result.msg.ok).toBe(false);
      expect('error' in result.msg).toBe(false);
    }
  });

  it('flags missing id as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'clone_result', ok: true }));
    expect(result.kind).toBe('bad');
  });

  it('flags missing ok as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'clone_result', id: 'clone-1' }));
    expect(result.kind).toBe('bad');
  });

  it('flags non-boolean ok as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'clone_result', id: 'clone-1', ok: 'true' }));
    expect(result.kind).toBe('bad');
  });
});

// ── Dispatcher routing smoke test ────────────────────────────────────────────
// Verify that clone_result lines reach the coordinator via parseInbound (integration of the
// two pieces). A full runLoop test is in runner-main.test.ts via SdkQueryFn seam.

describe('parseInbound + CloneCoordinator dispatcher integration', () => {
  it('a raw clone_result line parsed and dispatched resolves the pending clone', async () => {
    const ids: string[] = [];
    const c = new CloneCoordinator((_repo, id) => ids.push(id));
    const p = c.requestClone('owner/repo');
    const id = ids[0] ?? '';

    const rawLine = JSON.stringify({ type: 'clone_result', id, ok: true, workdir: '/workspace/owner-repo' });
    const parsed = parseInbound(rawLine);
    expect(parsed.kind).toBe('clone_result');
    if (parsed.kind === 'clone_result') {
      expect(c.handleResult(parsed.msg)).toBe(true);
    }
    await expect(p).resolves.toEqual({ ok: true, workdir: '/workspace/owner-repo' });
  });
});
