/**
 * Unit tests for container-side ChecksCoordinator (runner/src/checks.ts)
 * and the parseInbound run_checks_result case.
 */

import { describe, it, expect } from 'vitest';
import { parseInbound } from '../src/approval.js';
import { ChecksCoordinator } from '../src/checks.js';
import type { ChecksInput, ChecksOutcome } from '../src/checks.js';
import type { RunChecksResultMessage } from '../src/protocol.js';

describe('ChecksCoordinator', () => {
  it('emits request_run_checks with id checks-1 and default kind all', async () => {
    const emitted: Array<{ input: ChecksInput; id: string }> = [];
    const c = new ChecksCoordinator((input, id) => emitted.push({ input, id }));

    const p = c.requestChecks({ repo: 'owner/repo' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.input).toEqual({ repo: 'owner/repo', kind: 'all' });
    const id = emitted[0]?.id ?? '';
    expect(id).toBe('checks-1');
    expect(id).toMatch(/^checks-/);

    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    const msg: RunChecksResultMessage = {
      type: 'run_checks_result',
      id,
      ok: true,
      results: [
        { kind: 'lint', exitCode: 1, skipped: false, output: 'lint failed' },
        { kind: 'test', exitCode: 0, skipped: true, output: 'no tests' },
      ],
    };
    expect(c.handleResult(msg)).toBe(true);
    await expect(p).resolves.toEqual({
      ok: true,
      results: [
        { kind: 'lint', exitCode: 1, skipped: false, output: 'lint failed' },
        { kind: 'test', exitCode: 0, skipped: true, output: 'no tests' },
      ],
    });
  });

  it('handleResult with ok:false resolves with the reason', async () => {
    const ids: string[] = [];
    const c = new ChecksCoordinator((_input, id) => ids.push(id));
    const p = c.requestChecks({ repo: 'owner/repo', kind: 'test' });

    c.handleResult({ type: 'run_checks_result', id: ids[0] ?? '', ok: false, reason: 'run_checks unavailable' });
    await expect(p).resolves.toEqual({ ok: false, reason: 'run_checks unavailable' });
  });

  it('unknown id returns false and is ignored', () => {
    const c = new ChecksCoordinator(() => undefined);
    expect(
      c.handleResult({
        type: 'run_checks_result',
        id: 'checks-999',
        ok: true,
        results: [{ kind: 'lint', exitCode: 0, skipped: false, output: 'ok' }],
      }),
    ).toBe(false);
  });

  it('failAllPending resolves every pending request as ok:false+shutting down', async () => {
    const c = new ChecksCoordinator(() => undefined);
    const p1 = c.requestChecks({ repo: 'owner/repo1' });
    const p2 = c.requestChecks({ repo: 'owner/repo2', kind: 'lint' });

    c.failAllPending();
    await expect(p1).resolves.toEqual({ ok: false, reason: 'shutting down' });
    await expect(p2).resolves.toEqual({ ok: false, reason: 'shutting down' });
  });

  it('after draining, requestChecks resolves immediately and emits nothing', async () => {
    const emitted: string[] = [];
    const c = new ChecksCoordinator((_input, id) => emitted.push(id));
    c.failAllPending();

    await expect(c.requestChecks({ repo: 'owner/repo' })).resolves.toEqual({
      ok: false,
      reason: 'shutting down',
    });
    expect(emitted).toHaveLength(0);
  });

  it('sequential requestChecks calls use incrementing ids', async () => {
    const emitted: Array<{ input: ChecksInput; id: string }> = [];
    const c = new ChecksCoordinator((input, id) => emitted.push({ input, id }));

    const p1 = c.requestChecks({ repo: 'owner/repo1' });
    const p2 = c.requestChecks({ repo: 'owner/repo2', kind: 'test' });

    expect(emitted[0]?.id).toBe('checks-1');
    expect(emitted[1]?.id).toBe('checks-2');

    c.handleResult({
      type: 'run_checks_result',
      id: 'checks-1',
      ok: true,
      results: [{ kind: 'lint', exitCode: 0, skipped: false, output: 'ok' }],
    });
    c.handleResult({ type: 'run_checks_result', id: 'checks-2', ok: false, reason: 'failed' });

    const o1 = await p1 as ChecksOutcome;
    const o2 = await p2 as ChecksOutcome;
    expect(o1.ok).toBe(true);
    expect(o2.ok).toBe(false);
  });
});

describe('parseInbound — run_checks_result', () => {
  it('parses a well-formed success with raw lint/test output', () => {
    const result = parseInbound(
      JSON.stringify({
        type: 'run_checks_result',
        id: 'checks-1',
        ok: true,
        results: [
          { kind: 'lint', exitCode: 2, skipped: false, output: 'eslint raw output' },
          { kind: 'test', exitCode: 0, skipped: true, output: 'npm test missing' },
        ],
      }),
    );
    expect(result).toEqual({
      kind: 'run_checks_result',
      msg: {
        type: 'run_checks_result',
        id: 'checks-1',
        ok: true,
        results: [
          { kind: 'lint', exitCode: 2, skipped: false, output: 'eslint raw output' },
          { kind: 'test', exitCode: 0, skipped: true, output: 'npm test missing' },
        ],
      } satisfies RunChecksResultMessage,
    });
  });

  it('parses ok:false with reason', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'run_checks_result', id: 'checks-2', ok: false, reason: 'malformed request' }),
    );
    expect(result).toEqual({
      kind: 'run_checks_result',
      msg: { type: 'run_checks_result', id: 'checks-2', ok: false, reason: 'malformed request' } satisfies RunChecksResultMessage,
    });
  });

  it('flags malformed run_checks_result shapes as bad', () => {
    expect(parseInbound(JSON.stringify({ type: 'run_checks_result', ok: true, results: [] })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'run_checks_result', id: 'checks-1', ok: true })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'run_checks_result', id: 'checks-1', ok: true, results: {} })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({
      type: 'run_checks_result',
      id: 'checks-1',
      ok: true,
      results: [{ kind: 'build', exitCode: 0, skipped: false, output: 'nope' }],
    })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({
      type: 'run_checks_result',
      id: 'checks-1',
      ok: true,
      results: [{ kind: 'lint', exitCode: '0', skipped: false, output: 'nope' }],
    })).kind).toBe('bad');
  });
});
