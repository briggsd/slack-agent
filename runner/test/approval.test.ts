/**
 * Unit tests for the container-side commit gate (runner/src/approval.ts).
 * Pure and deterministic — no SDK, no stdio, no Docker.
 */

import { describe, it, expect } from 'vitest';
import { ApprovalCoordinator, parseInbound } from '../src/approval.js';

describe('ApprovalCoordinator', () => {
  it('emits request_approval and resolves when the matching verdict arrives', async () => {
    const emitted: Array<{ specRef: string; id: string }> = [];
    const c = new ApprovalCoordinator((specRef, id) => emitted.push({ specRef, id }));

    const p = c.requestApproval('SPEC A');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.specRef).toBe('SPEC A');
    const id = emitted[0]?.id ?? '';
    expect(id).toMatch(/^appr-/);

    expect(c.handleVerdict({ type: 'approval_verdict', id, approved: true })).toBe(true);
    await expect(p).resolves.toEqual({ approved: true });
  });

  it('carries feedback through on a not-approved verdict', async () => {
    const ids: string[] = [];
    const c = new ApprovalCoordinator((_s, id) => ids.push(id));
    const p = c.requestApproval('SPEC');
    c.handleVerdict({ type: 'approval_verdict', id: ids[0] ?? '', approved: false, feedback: 'make it faster' });
    await expect(p).resolves.toEqual({ approved: false, feedback: 'make it faster' });
  });

  it('ignores an unknown or already-settled id (returns false, never throws)', async () => {
    const ids: string[] = [];
    const c = new ApprovalCoordinator((_s, id) => ids.push(id));
    const p = c.requestApproval('SPEC');
    const id = ids[0] ?? '';

    expect(c.handleVerdict({ type: 'approval_verdict', id: 'appr-999', approved: true })).toBe(false);
    expect(c.handleVerdict({ type: 'approval_verdict', id, approved: true })).toBe(true);
    // A duplicate delivery of the same id is a no-op.
    expect(c.handleVerdict({ type: 'approval_verdict', id, approved: false })).toBe(false);
    await expect(p).resolves.toEqual({ approved: true });
  });

  it('gives concurrent gates distinct ids that resolve independently', async () => {
    const ids: string[] = [];
    const c = new ApprovalCoordinator((_s, id) => ids.push(id));
    const p1 = c.requestApproval('A');
    const p2 = c.requestApproval('B');
    expect(ids[0]).not.toBe(ids[1]);

    c.handleVerdict({ type: 'approval_verdict', id: ids[1] ?? '', approved: true });
    c.handleVerdict({ type: 'approval_verdict', id: ids[0] ?? '', approved: false, feedback: 'no' });
    await expect(p1).resolves.toEqual({ approved: false, feedback: 'no' });
    await expect(p2).resolves.toEqual({ approved: true });
  });

  it('failAllPending resolves every parked gate as not-approved (shutdown unblock)', async () => {
    const ids: string[] = [];
    const c = new ApprovalCoordinator((_s, id) => ids.push(id));
    const p1 = c.requestApproval('A');
    const p2 = c.requestApproval('B');
    c.failAllPending();
    await expect(p1).resolves.toEqual({ approved: false });
    await expect(p2).resolves.toEqual({ approved: false });
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
    expect(parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a1', approved: true }))).toEqual({
      kind: 'verdict',
      msg: { type: 'approval_verdict', id: 'a1', approved: true },
    });
    expect(
      parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a1', approved: false, feedback: 'x' })),
    ).toEqual({
      kind: 'verdict',
      msg: { type: 'approval_verdict', id: 'a1', approved: false, feedback: 'x' },
    });
  });

  it('flags bad json, wrong shape, and unknown type as bad', () => {
    expect(parseInbound('not json').kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'user_message', id: 1, text: 'x' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'approval_verdict', id: 'a', approved: 'yes' })).kind).toBe('bad');
    expect(parseInbound(JSON.stringify({ type: 'whatever' })).kind).toBe('bad');
  });
});
