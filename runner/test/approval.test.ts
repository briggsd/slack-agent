/**
 * Unit tests for runner/src/approval.ts.
 * Pure and deterministic — no SDK, no stdio, no Docker.
 */

import { describe, it, expect } from 'vitest';
import { ApprovalCoordinator, parseInbound } from '../src/approval.js';
import type { BuildResultMessage } from '../src/protocol.js';

function makeCoordinator() {
  const emitted: Array<{ specRef: string; id: string }> = [];
  let stateFile: string | null = null;
  let mkdirCalls = 0;
  const coordinator = new ApprovalCoordinator(
    (specRef, id) => emitted.push({ specRef, id }),
    async () => stateFile,
    async (data) => {
      stateFile = data;
    },
    async () => {
      mkdirCalls++;
    },
  );
  return {
    coordinator,
    emitted,
    getStateFile: () => stateFile,
    setStateFile: (data: string | null) => {
      stateFile = data;
    },
    getMkdirCalls: () => mkdirCalls,
  };
}

describe('ApprovalCoordinator', () => {
  it('first request emits request_approval and returns requested', async () => {
    const { coordinator, emitted, getMkdirCalls } = makeCoordinator();

    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.specRef).toBe('SPEC A');
    expect(emitted[0]?.id).toMatch(/^appr-/);
    expect(getMkdirCalls()).toBe(1);
  });

  it('same spec while still pending re-emits the existing request', async () => {
    const { coordinator, emitted } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });

    expect(emitted).toEqual([
      { specRef: 'SPEC A', id },
      { specRef: 'SPEC A', id },
    ]);
  });

  it('same spec consumes an approved verdict exactly once', async () => {
    const { coordinator, emitted, getStateFile } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';
    await expect(coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: true })).resolves.toBe(true);
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'approved' });
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });

    expect(getStateFile()).toContain('"status":"requested"');
    expect(emitted).toHaveLength(2);
  });

  it('same spec consumes rejected feedback exactly once', async () => {
    const { coordinator, emitted } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';
    await coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: false, feedback: 'make it faster' });

    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({
      status: 'rejected',
      feedback: 'make it faster',
    });
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });
  });

  it('a changed spec starts a fresh approval request', async () => {
    const { coordinator, emitted } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    await expect(coordinator.requestApproval('SPEC B')).resolves.toEqual({ status: 'requested' });

    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.specRef).toBe('SPEC B');
  });

  it('persists requested state so a new coordinator instance can accept a trusted gateway verdict', async () => {
    const first = makeCoordinator();
    await first.coordinator.requestApproval('SPEC A');

    const second = makeCoordinator();
    second.setStateFile(first.getStateFile());
    const id = first.emitted[0]?.id ?? '';
    await expect(second.coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });
    expect(second.emitted).toEqual([{ specRef: 'SPEC A', id }]);

    await expect(second.coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: true })).resolves.toBe(true);

    await expect(second.coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'approved' });
  });

  it('rejects a verdict whose trusted specRef does not match the pending request', async () => {
    const { coordinator, emitted } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';

    await expect(
      coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC B', approved: true }),
    ).resolves.toBe(false);
    await expect(
      coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: true }),
    ).resolves.toBe(true);
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'approved' });
  });

  it('does not trust a forged approved verdict loaded from the agent-writable state file', async () => {
    const { coordinator, emitted, setStateFile } = makeCoordinator();
    setStateFile(JSON.stringify({
      version: 1,
      status: 'approved',
      id: 'appr-1',
      specRef: 'SPEC A',
    }));

    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'requested' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.specRef).toBe('SPEC A');
  });

  it('does not persist trusted verdicts to the agent-writable state file', async () => {
    const { coordinator, emitted, getStateFile } = makeCoordinator();
    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';
    await coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: true });

    expect(getStateFile()).toContain('"status":"requested"');
    await expect(coordinator.requestApproval('SPEC A')).resolves.toEqual({ status: 'approved' });
    expect(getStateFile()).toBe(JSON.stringify({ version: 1, status: 'idle' }));
  });

  it('ignores an unknown or stale verdict id', async () => {
    const { coordinator, emitted } = makeCoordinator();

    await coordinator.requestApproval('SPEC A');
    const id = emitted[0]?.id ?? '';

    await expect(coordinator.handleVerdict({ type: 'approval_verdict', id: 'appr-999', specRef: 'SPEC A', approved: true })).resolves.toBe(false);
    await expect(coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: true })).resolves.toBe(true);
    await expect(coordinator.handleVerdict({ type: 'approval_verdict', id, specRef: 'SPEC A', approved: false })).resolves.toBe(false);
  });

  it('after draining, a new requestApproval resolves rejected and emits nothing', async () => {
    const { coordinator, emitted } = makeCoordinator();
    coordinator.failAllPending();

    await expect(coordinator.requestApproval('post-drain spec')).resolves.toEqual({ status: 'rejected' });
    expect(emitted).toHaveLength(0);
  });
});

describe('parseInbound', () => {
  it('parses a well-formed user_message', () => {
    expect(parseInbound(JSON.stringify({ type: 'user_message', id: 'u1', text: 'hi' }))).toEqual({
      kind: 'user',
      msg: { type: 'user_message', id: 'u1', text: 'hi' },
    });
  });

  it('parses an approval_verdict with and without feedback', () => {
    expect(parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a1', specRef: 'SPEC A', approved: true }))).toEqual({
      kind: 'verdict',
      msg: { type: 'approval_verdict', id: 'a1', specRef: 'SPEC A', approved: true },
    });
    expect(
      parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a1', specRef: 'SPEC A', approved: false, feedback: 'x' })),
    ).toEqual({
      kind: 'verdict',
      msg: { type: 'approval_verdict', id: 'a1', specRef: 'SPEC A', approved: false, feedback: 'x' },
    });
  });

  it('flags bad json, wrong shape, and unknown type as bad', () => {
    expect(parseInbound('not json').kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'user_message', id: 1, text: 'x' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a', approved: 'yes' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a', approved: true })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'whatever' })).kind).toBe('bad');
  });
});

describe('parseInbound — build_result', () => {
  it('parses a well-formed legacy build_result with ok:true and prUrl', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'build_result', id: 'build-1', ok: true, prUrl: 'https://github.com/owner/repo/pull/1' }),
    );
    expect(result).toEqual({
      kind: 'build_result',
      msg: { type: 'build_result', id: 'build-1', ok: true, prUrl: 'https://github.com/owner/repo/pull/1' } satisfies BuildResultMessage,
    });
  });

  it('parses a well-formed build_result with ok:false and reason', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'build_result', id: 'build-2', ok: false, reason: 'tests failed' }),
    );
    expect(result).toEqual({
      kind: 'build_result',
      msg: { type: 'build_result', id: 'build-2', ok: false, reason: 'tests failed' } satisfies BuildResultMessage,
    });
  });

  it('parses ok:true without prUrl (prUrl absent in parsed msg)', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'build_result', id: 'build-3', ok: true }),
    );
    expect(result.kind).toBe('build_result');
    if (result.kind === 'build_result') {
      expect(result.msg.ok).toBe(true);
      expect(result.msg.id).toBe('build-3');
      expect('prUrl' in result.msg).toBe(false);
    }
  });

  it('parses ok:false without reason (reason absent in parsed msg)', () => {
    const result = parseInbound(
      JSON.stringify({ type: 'build_result', id: 'build-4', ok: false }),
    );
    expect(result.kind).toBe('build_result');
    if (result.kind === 'build_result') {
      expect(result.msg.ok).toBe(false);
      expect('reason' in result.msg).toBe(false);
    }
  });

  it('flags missing id as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'build_result', ok: true }));
    expect(result.kind).toBe('bad');
  });

  it('flags missing ok as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'build_result', id: 'build-1' }));
    expect(result.kind).toBe('bad');
  });

  it('flags non-boolean ok as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'build_result', id: 'build-1', ok: 'true' }));
    expect(result.kind).toBe('bad');
  });

  it('flags non-string id as bad', () => {
    const result = parseInbound(JSON.stringify({ type: 'build_result', id: 42, ok: true }));
    expect(result.kind).toBe('bad');
  });
});
