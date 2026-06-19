/**
 * Tests for the loopUntil combinator (src/blueprints/combinators.ts).
 *
 * Generic engine test — uses tiny local stub Ctx/Deps, not the one-shot types.
 * Fully offline.
 */

import { describe, it, expect } from 'vitest';
import type { BlueprintNode } from '../src/blueprints/types.js';
import type { RunnerEvent, GateResume, RunnerStream } from '../src/runner/types.js';
import { loopUntil } from '../src/blueprints/combinators.js';

interface Ctx {
  passes?: number;
  approved?: boolean;
  resume?: GateResume | undefined;
}
interface Deps {}

async function drain(gen: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** A node that bumps ctx.passes and approves on the Nth pass. */
function approveOnPass(n: number): BlueprintNode<Ctx, Deps> {
  return {
    name: 'tick',
    kind: 'deterministic',
    async *run(ctx: Ctx): AsyncGenerator<RunnerEvent> {
      ctx.passes = (ctx.passes ?? 0) + 1;
      if (ctx.passes >= n) ctx.approved = true;
      yield { type: 'status', text: `pass ${String(ctx.passes)}` };
    },
  };
}

describe('loopUntil', () => {
  it('runs the body until done(ctx) holds', async () => {
    const ctx: Ctx = {};
    const node = loopUntil<Ctx, Deps>([approveOnPass(3)], {
      name: 'loop',
      done: (c) => c.approved === true,
    });
    const events = await drain(node.run(ctx, {}));
    expect(ctx.passes).toBe(3);
    expect(events.map((e) => (e.type === 'status' ? e.text : e.type))).toEqual([
      'pass 1',
      'pass 2',
      'pass 3',
    ]);
  });

  it('returns immediately after the first pass when done already holds', async () => {
    const ctx: Ctx = {};
    const node = loopUntil<Ctx, Deps>([approveOnPass(1)], {
      name: 'loop',
      done: (c) => c.approved === true,
    });
    await drain(node.run(ctx, {}));
    expect(ctx.passes).toBe(1);
  });

  it('throws once maxIterations is exhausted without done', async () => {
    const ctx: Ctx = {};
    const node = loopUntil<Ctx, Deps>([approveOnPass(99)], {
      name: 'capped-loop',
      done: (c) => c.approved === true,
      maxIterations: 3,
    });
    await expect(drain(node.run(ctx, {}))).rejects.toThrow(/capped-loop: not done after 3/);
    expect(ctx.passes).toBe(3);
  });

  it('rejects maxIterations < 1 at construction', () => {
    expect(() =>
      loopUntil<Ctx, Deps>([approveOnPass(1)], { name: 'x', done: () => true, maxIterations: 0 }),
    ).toThrow(RangeError);
  });

  it('is agentic if any body node is agentic, else deterministic', () => {
    const det = loopUntil<Ctx, Deps>([approveOnPass(1)], { name: 'd', done: () => true });
    expect(det.kind).toBe('deterministic');

    const agentic: BlueprintNode<Ctx, Deps> = {
      name: 'a',
      kind: 'agentic',
      async *run(): AsyncGenerator<RunnerEvent> {},
    };
    const mixed = loopUntil<Ctx, Deps>([agentic], { name: 'm', done: () => true });
    expect(mixed.kind).toBe('agentic');
  });

  it('threads a resume value into a parked body node across iterations', async () => {
    // A gate-like node that parks, records the resume it gets, and approves on "ok".
    const gate: BlueprintNode<Ctx, Deps> = {
      name: 'gate',
      kind: 'deterministic',
      async *run(ctx: Ctx): RunnerStream {
        const resume: GateResume | undefined = yield { type: 'await_approval', prompt: 'p' };
        ctx.resume = resume;
        if (resume?.kind === 'reply' && resume.text === 'ok') ctx.approved = true;
      },
    };
    const ctx: Ctx = {};
    const it = loopUntil<Ctx, Deps>([gate], { name: 'loop', done: (c) => c.approved === true }).run(
      ctx,
      {},
    );

    // Pass 1: park, feed a non-approving reply → loop again.
    const first = await it.next();
    expect(first.value).toEqual({ type: 'await_approval', prompt: 'p' });
    const second = await it.next({ kind: 'reply', text: 'nope' });
    // The loop re-runs the gate and parks again (still not approved).
    expect(ctx.resume).toEqual({ kind: 'reply', text: 'nope' });
    expect(second.done).toBe(false);
    expect(second.value).toEqual({ type: 'await_approval', prompt: 'p' });

    // Pass 2: feed the approving reply → done.
    const third = await it.next({ kind: 'reply', text: 'ok' });
    expect(ctx.approved).toBe(true);
    expect(third.done).toBe(true);
  });
});
