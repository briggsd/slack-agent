/**
 * Unit tests for container-side ProvisionCoordinator and parseInbound provision_result.
 */

import { describe, expect, it } from 'vitest';
import { parseInbound } from '../src/approval.js';
import { ProvisionCoordinator } from '../src/provision.js';
import type { ProvisionInput, ProvisionOutcome } from '../src/provision.js';
import type { ProvisionResultMessage } from '../src/protocol.js';

describe('ProvisionCoordinator', () => {
  it('emits request_provision with id provision-1', async () => {
    const emitted: Array<{ input: ProvisionInput; id: string }> = [];
    const c = new ProvisionCoordinator((input, id) => emitted.push({ input, id }));

    const p = c.requestProvision({ name: 'python' });
    expect(emitted).toEqual([{ input: { name: 'python' }, id: 'provision-1' }]);

    let resolved = false;
    void p.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(c.handleResult({ type: 'provision_result', id: 'provision-1', ok: true })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('handleResult with ok:false resolves with the error', async () => {
    const ids: string[] = [];
    const c = new ProvisionCoordinator((_input, id) => ids.push(id));
    const p = c.requestProvision({ name: 'ruby' });

    c.handleResult({ type: 'provision_result', id: ids[0] ?? '', ok: false, error: 'runtime not available' });
    await expect(p).resolves.toEqual({ ok: false, error: 'runtime not available' });
  });

  it('unknown id returns false and is ignored', () => {
    const c = new ProvisionCoordinator(() => undefined);
    expect(c.handleResult({ type: 'provision_result', id: 'provision-999', ok: true })).toBe(false);
  });

  it('failAllPending resolves every pending request as ok:false+shutting down', async () => {
    const c = new ProvisionCoordinator(() => undefined);
    const p1 = c.requestProvision({ name: 'python' });
    const p2 = c.requestProvision({ name: 'ruby' });

    c.failAllPending();
    await expect(p1).resolves.toEqual({ ok: false, error: 'shutting down' });
    await expect(p2).resolves.toEqual({ ok: false, error: 'shutting down' });
  });

  it('after draining, requestProvision resolves immediately and emits nothing', async () => {
    const emitted: string[] = [];
    const c = new ProvisionCoordinator((_input, id) => emitted.push(id));
    c.failAllPending();

    await expect(c.requestProvision({ name: 'python' })).resolves.toEqual({
      ok: false,
      error: 'shutting down',
    });
    expect(emitted).toHaveLength(0);
  });

  it('sequential requestProvision calls use incrementing ids', async () => {
    const emitted: Array<{ input: ProvisionInput; id: string }> = [];
    const c = new ProvisionCoordinator((input, id) => emitted.push({ input, id }));

    const p1 = c.requestProvision({ name: 'python' });
    const p2 = c.requestProvision({ name: 'ruby' });

    expect(emitted[0]?.id).toBe('provision-1');
    expect(emitted[1]?.id).toBe('provision-2');

    c.handleResult({ type: 'provision_result', id: 'provision-1', ok: true });
    c.handleResult({ type: 'provision_result', id: 'provision-2', ok: false, error: 'failed' });

    const o1 = await p1 as ProvisionOutcome;
    const o2 = await p2 as ProvisionOutcome;
    expect(o1.ok).toBe(true);
    expect(o2).toEqual({ ok: false, error: 'failed' });
  });
});

describe('parseInbound — provision_result', () => {
  it('parses a well-formed success', () => {
    expect(parseInbound(JSON.stringify({
      type: 'provision_result',
      id: 'provision-1',
      ok: true,
    }))).toEqual({
      kind: 'provision_result',
      msg: { type: 'provision_result', id: 'provision-1', ok: true } satisfies ProvisionResultMessage,
    });
  });

  it('parses ok:false with error', () => {
    expect(parseInbound(JSON.stringify({
      type: 'provision_result',
      id: 'provision-2',
      ok: false,
      error: 'runtime not available',
    }))).toEqual({
      kind: 'provision_result',
      msg: {
        type: 'provision_result',
        id: 'provision-2',
        ok: false,
        error: 'runtime not available',
      } satisfies ProvisionResultMessage,
    });
  });

  it('flags malformed provision_result shapes as bad', () => {
    expect(parseInbound(JSON.stringify({ type: 'provision_result', ok: true })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'provision_result', id: 'provision-1', ok: 'yes' })).kind).toBe('bad');
  });
});
