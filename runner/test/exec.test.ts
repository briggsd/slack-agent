/**
 * Unit tests for container-side ExecCoordinator (runner/src/exec.ts)
 * and the parseInbound exec_result case.
 */

import { describe, it, expect } from 'vitest';
import { ExecCoordinator } from '../src/exec.js';
import { parseInbound } from '../src/approval.js';
import type { ExecInput } from '../src/exec.js';
import type { ExecResultMessage } from '../src/protocol.js';

const INPUT: ExecInput = {
  host: 'github',
  repo: 'owner/repo',
  instruction: 'implement the thing',
};

describe('ExecCoordinator', () => {
  it('emits request_exec with id exec-1 and parks until the matching result arrives', async () => {
    const emitted: Array<{ input: ExecInput; id: string }> = [];
    const c = new ExecCoordinator((input, id) => emitted.push({ input, id }));

    const p = c.requestExec(INPUT);
    expect(emitted).toEqual([{ input: INPUT, id: 'exec-1' }]);

    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(c.handleResult({ type: 'exec_result', id: 'exec-1', ok: true, prUrl: 'https://pr/1' })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, prUrl: 'https://pr/1' });
  });

  it('ok:false resolves with the reason and unknown ids are ignored', async () => {
    const ids: string[] = [];
    const c = new ExecCoordinator((_input, id) => ids.push(id));
    const p = c.requestExec(INPUT);

    expect(c.handleResult({ type: 'exec_result', id: 'exec-999', ok: true })).toBe(false);
    expect(c.handleResult({ type: 'exec_result', id: ids[0] ?? '', ok: false, reason: 'not opted in' })).toBe(true);
    await expect(p).resolves.toEqual({ ok: false, reason: 'not opted in' });
  });

  it('failAllPending resolves pending and future exec requests as shutting down', async () => {
    const emitted: string[] = [];
    const c = new ExecCoordinator((_input, id) => emitted.push(id));
    const p = c.requestExec(INPUT);

    c.failAllPending();
    await expect(p).resolves.toEqual({ ok: false, reason: 'shutting down' });
    await expect(c.requestExec(INPUT)).resolves.toEqual({ ok: false, reason: 'shutting down' });
    expect(emitted).toEqual(['exec-1']);
  });
});

describe('parseInbound — exec_result', () => {
  it('parses ok:true with prUrl and ok:false with reason', () => {
    const ok = parseInbound(JSON.stringify({
      type: 'exec_result',
      id: 'exec-1',
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
    }));
    expect(ok).toEqual({
      kind: 'exec_result',
      msg: {
        type: 'exec_result',
        id: 'exec-1',
        ok: true,
        prUrl: 'https://github.com/owner/repo/pull/1',
      } satisfies ExecResultMessage,
    });

    const refused = parseInbound(JSON.stringify({
      type: 'exec_result',
      id: 'exec-2',
      ok: false,
      reason: 'exec requires opt-in',
    }));
    expect(refused).toEqual({
      kind: 'exec_result',
      msg: {
        type: 'exec_result',
        id: 'exec-2',
        ok: false,
        reason: 'exec requires opt-in',
      } satisfies ExecResultMessage,
    });
  });

  it('flags malformed exec_result shapes as bad', () => {
    expect(parseInbound(JSON.stringify({ type: 'exec_result', ok: true })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'exec_result', id: 'exec-1' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'exec_result', id: 'exec-1', ok: 'true' })).kind).toBe('bad');
  });
});
