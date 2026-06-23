/**
 * Unit tests for the extracted RequestCoordinator base (runner/src/request-coordinator.ts).
 *
 * Uses trivial TInput / TResultMessage / TOutcome types — no real protocol dependency.
 */

import { describe, it, expect } from 'vitest';
import { RequestCoordinator } from '../src/request-coordinator.js';

// ── trivial test types ────────────────────────────────────────────────────────

type TestInput = string;
interface TestResultMessage {
  id: string;
  value: string;
}
type TestOutcome = { ok: true; value: string } | { ok: false; reason: string };

const shutdownOutcome: TestOutcome = { ok: false, reason: 'shutting down' };

function makeCoordinator(emitted: Array<{ input: TestInput; id: string }>) {
  return new RequestCoordinator<TestInput, TestResultMessage, TestOutcome>(
    'test',
    (input, id) => emitted.push({ input, id }),
    (msg) => ({ ok: true, value: msg.value }),
    shutdownOutcome,
  );
}

// ── RequestCoordinator ────────────────────────────────────────────────────────

describe('RequestCoordinator', () => {
  it('request emits with prefix-n id and returns a pending promise', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    const p = c.request('hello');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.input).toBe('hello');
    expect(emitted[0]?.id).toBe('test-1');

    // Promise is still pending — not yet resolved
    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('sequential requests use incrementing ids', () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    void c.request('a');
    void c.request('b');
    void c.request('c');

    expect(emitted[0]?.id).toBe('test-1');
    expect(emitted[1]?.id).toBe('test-2');
    expect(emitted[2]?.id).toBe('test-3');
  });

  it('handleResult resolves the matching id via fromMessage and returns true', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    const p = c.request('hello');
    const id = emitted[0]?.id ?? '';

    const result = c.handleResult({ id, value: 'world' });
    expect(result).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, value: 'world' });
  });

  it('handleResult with an unknown id returns false', () => {
    const c = makeCoordinator([]);
    expect(c.handleResult({ id: 'test-999', value: 'x' })).toBe(false);
  });

  it('handleResult with an already-settled id returns false (duplicate delivery)', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    const p = c.request('hello');
    const id = emitted[0]?.id ?? '';

    expect(c.handleResult({ id, value: 'first' })).toBe(true);
    expect(c.handleResult({ id, value: 'second' })).toBe(false);
    await expect(p).resolves.toEqual({ ok: true, value: 'first' });
  });

  it('failAllPending resolves every pending promise to the shutdown outcome', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    const p1 = c.request('a');
    const p2 = c.request('b');

    c.failAllPending();
    await expect(p1).resolves.toEqual(shutdownOutcome);
    await expect(p2).resolves.toEqual(shutdownOutcome);
  });

  it('after failAllPending, a subsequent request resolves immediately to the shutdown outcome', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    c.failAllPending();

    const countBefore = emitted.length;
    const p = c.request('late');
    expect(emitted.length).toBe(countBefore); // nothing emitted — already drained
    await expect(p).resolves.toEqual(shutdownOutcome);
  });

  it('concurrent requests get distinct ids and resolve independently', async () => {
    const emitted: Array<{ input: TestInput; id: string }> = [];
    const c = makeCoordinator(emitted);

    const p1 = c.request('first');
    const p2 = c.request('second');

    expect(emitted[0]?.id).not.toBe(emitted[1]?.id);

    const [id1, id2] = [emitted[0]?.id ?? '', emitted[1]?.id ?? ''];
    c.handleResult({ id: id2, value: 'from-second' });
    c.handleResult({ id: id1, value: 'from-first' });

    await expect(p1).resolves.toEqual({ ok: true, value: 'from-first' });
    await expect(p2).resolves.toEqual({ ok: true, value: 'from-second' });
  });
});
