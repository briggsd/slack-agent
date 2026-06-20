/**
 * Unit tests for container-side PublishCoordinator (runner/src/publish.ts)
 * and the parseInbound publish_result case.
 */

import { describe, it, expect } from 'vitest';
import { parseInbound } from '../src/approval.js';
import { PublishCoordinator } from '../src/publish.js';
import type { PublishInput, PublishOutcome } from '../src/publish.js';
import type { PublishResultMessage } from '../src/protocol.js';

describe('PublishCoordinator', () => {
  it('emits request_publish with id publish-1 and parks until the matching result arrives', async () => {
    const emitted: Array<{ input: PublishInput; id: string }> = [];
    const c = new PublishCoordinator((input, id) => emitted.push({ input, id }));

    const p = c.requestPublish({ repo: 'owner/repo', title: 'Ship it' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.input).toEqual({ repo: 'owner/repo', title: 'Ship it' });
    const id = emitted[0]?.id ?? '';
    expect(id).toBe('publish-1');
    expect(id).toMatch(/^publish-/);

    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const msg: PublishResultMessage = {
      type: 'publish_result',
      id,
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
    };
    expect(c.handleResult(msg)).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/1' });
  });

  it('handleResult with ok:false resolves with the reason', async () => {
    const ids: string[] = [];
    const c = new PublishCoordinator((_input, id) => ids.push(id));
    const p = c.requestPublish({ repo: 'owner/repo' });

    c.handleResult({ type: 'publish_result', id: ids[0] ?? '', ok: false, reason: 'push failed' });
    await expect(p).resolves.toEqual({ ok: false, reason: 'push failed' });
  });

  it('unknown id returns false and is ignored', () => {
    const c = new PublishCoordinator(() => undefined);
    expect(
      c.handleResult({
        type: 'publish_result',
        id: 'publish-999',
        ok: true,
        prUrl: 'https://github.com/x/y/pull/1',
      }),
    ).toBe(false);
  });

  it('failAllPending resolves every pending publish as ok:false+shutting down', async () => {
    const ids: string[] = [];
    const c = new PublishCoordinator((_input, id) => ids.push(id));
    const p1 = c.requestPublish({ repo: 'owner/repo1' });
    const p2 = c.requestPublish({ repo: 'owner/repo2' });

    c.failAllPending();
    await expect(p1).resolves.toEqual({ ok: false, reason: 'shutting down' });
    await expect(p2).resolves.toEqual({ ok: false, reason: 'shutting down' });
  });

  it('after draining, requestPublish resolves immediately and emits nothing', async () => {
    const emitted: string[] = [];
    const c = new PublishCoordinator((_input, id) => emitted.push(id));
    c.failAllPending();

    await expect(c.requestPublish({ repo: 'owner/repo' })).resolves.toEqual({
      ok: false,
      reason: 'shutting down',
    });
    expect(emitted).toHaveLength(0);
  });

  it('concurrent publishes get distinct ids and resolve independently', async () => {
    const ids: string[] = [];
    const c = new PublishCoordinator((_input, id) => ids.push(id));
    const p1 = c.requestPublish({ repo: 'owner/repo1' });
    const p2 = c.requestPublish({ repo: 'owner/repo2' });
    expect(ids[0]).not.toBe(ids[1]);

    const [id1, id2] = ids as [string, string];
    c.handleResult({ type: 'publish_result', id: id2, ok: false, reason: 'auth failed' });
    c.handleResult({ type: 'publish_result', id: id1, ok: true, prUrl: 'https://github.com/owner/repo1/pull/1' });

    await expect(p1).resolves.toEqual({ ok: true, prUrl: 'https://github.com/owner/repo1/pull/1' });
    await expect(p2).resolves.toEqual({ ok: false, reason: 'auth failed' });
  });

  it('sequential requestPublish calls use incrementing ids', async () => {
    const emitted: Array<{ input: PublishInput; id: string }> = [];
    const c = new PublishCoordinator((input, id) => emitted.push({ input, id }));

    const p1 = c.requestPublish({ repo: 'owner/repo1' });
    const p2 = c.requestPublish({ repo: 'owner/repo2' });

    expect(emitted[0]?.id).toBe('publish-1');
    expect(emitted[1]?.id).toBe('publish-2');

    c.handleResult({ type: 'publish_result', id: 'publish-1', ok: true, prUrl: 'https://pr/1' });
    c.handleResult({ type: 'publish_result', id: 'publish-2', ok: false, reason: 'failed' });

    const o1 = await p1 as PublishOutcome;
    const o2 = await p2 as PublishOutcome;
    expect(o1.ok).toBe(true);
    expect(o2.ok).toBe(false);
  });
});

describe('parseInbound — publish_result', () => {
  it('parses a well-formed publish_result with ok:true and prUrl', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'publish_result', id: 'publish-1', ok: true, prUrl: 'https://github.com/owner/repo/pull/1' }),
    );
    expect(result).toEqual({
      kind: 'publish_result',
      msg: {
        type: 'publish_result',
        id: 'publish-1',
        ok: true,
        prUrl: 'https://github.com/owner/repo/pull/1',
      } satisfies PublishResultMessage,
    });
  });

  it('parses a well-formed publish_result with ok:false and reason', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'publish_result', id: 'publish-2', ok: false, reason: 'push failed' }),
    );
    expect(result).toEqual({
      kind: 'publish_result',
      msg: { type: 'publish_result', id: 'publish-2', ok: false, reason: 'push failed' } satisfies PublishResultMessage,
    });
  });

  it('parses ok:true without prUrl and ok:false without reason', () => {
    const okResult = parseInbound(JSON.stringify({ type: 'publish_result', id: 'publish-3', ok: true }));
    expect(okResult.kind).toBe('publish_result');
    if (okResult.kind === 'publish_result') {
      expect(okResult.msg.ok).toBe(true);
      expect('prUrl' in okResult.msg).toBe(false);
    }

    const failResult = parseInbound(JSON.stringify({ type: 'publish_result', id: 'publish-4', ok: false }));
    expect(failResult.kind).toBe('publish_result');
    if (failResult.kind === 'publish_result') {
      expect(failResult.msg.ok).toBe(false);
      expect('reason' in failResult.msg).toBe(false);
    }
  });

  it('flags malformed publish_result shapes as bad', () => {
    expect(parseInbound(JSON.stringify({ type: 'publish_result', ok: true })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'publish_result', id: 'publish-1' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'publish_result', id: 'publish-1', ok: 'true' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'publish_result', id: 42, ok: true })).kind).toBe('bad');
  });
});
