/**
 * Tests for the blueprint framework.
 *
 * Split into two groups:
 *   1. Engine tests — prove `runBlueprint` is generic by using a tiny local
 *      stub Ctx/Deps, NOT the one-shot types. Import only from src/blueprints/.
 *   2. Registry/blueprint tests — exercise blueprintFor + repoOneshot; import
 *      from src/oneshot/.
 *
 * Everything is fully offline — no Docker, no network, no API.
 */

import { describe, it, expect } from 'vitest';
import type { BlueprintNode, Blueprint } from '../src/blueprints/types.js';
import type { RunnerEvent } from '../src/runner/types.js';
import { runBlueprint } from '../src/blueprints/executor.js';
import { boundedRetry } from '../src/blueprints/combinators.js';
import { blueprintFor } from '../src/oneshot/registry.js';
import { repoOneshot } from '../src/oneshot/repo-oneshot.js';

// ── Engine test stub types ────────────────────────────────────────────────────

interface TestCtx {
  marker?: string;
}

interface TestDeps {}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(gen: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

function makeCtx(): TestCtx {
  return {};
}

function makeDeps(): TestDeps {
  return {};
}

/** Makes a simple counter node that records how many times it ran. */
function makeCounterNode(
  name: string,
  runCounts: number[],
): BlueprintNode<TestCtx, TestDeps> {
  return {
    name,
    kind: 'deterministic',
    async *run(): AsyncGenerator<RunnerEvent> {
      runCounts.push(1);
      yield { type: 'status', text: `${name} ran` };
    },
  };
}

// ── runBlueprint — node ordering ─────────────────────────────────────────────

describe('runBlueprint — node ordering', () => {
  it('runs nodes in order and forwards their events', async () => {
    const calls: string[] = [];

    const nodeA: BlueprintNode<TestCtx, TestDeps> = {
      name: 'node-a',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('a-start');
        yield { type: 'status', text: 'a running' };
        calls.push('a-end');
      },
    };

    const nodeB: BlueprintNode<TestCtx, TestDeps> = {
      name: 'node-b',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('b-start');
        yield { type: 'status', text: 'b running' };
        calls.push('b-end');
      },
    };

    const nodeC: BlueprintNode<TestCtx, TestDeps> = {
      name: 'node-c',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('c-start');
        yield { type: 'status', text: 'c running' };
        calls.push('c-end');
      },
    };

    const blueprint: Blueprint<TestCtx, TestDeps> = { id: 'test', nodes: [nodeA, nodeB, nodeC] };
    const ctx = makeCtx();
    const deps = makeDeps();

    const events = await drain(runBlueprint(blueprint, ctx, deps));

    // All three nodes ran, in order
    expect(calls).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);

    // Events forwarded in order
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);
    expect(statusTexts).toEqual(['a running', 'b running', 'c running']);
  });
});

// ── runBlueprint — error handling ─────────────────────────────────────────────

describe('runBlueprint — error handling', () => {
  it('a throwing node yields exactly one error event, stops, and does not re-throw', async () => {
    const laterNodeRan: boolean[] = [];

    const failingNode: BlueprintNode<TestCtx, TestDeps> = {
      name: 'failing',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        yield { type: 'status', text: 'about to fail' };
        throw new Error('node exploded');
      },
    };

    const laterNode: BlueprintNode<TestCtx, TestDeps> = {
      name: 'later',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        laterNodeRan.push(true);
        yield { type: 'status', text: 'later ran' };
      },
    };

    const blueprint: Blueprint<TestCtx, TestDeps> = { id: 'test', nodes: [failingNode, laterNode] };
    const ctx = makeCtx();
    const deps = makeDeps();

    // runBlueprint must not throw — it converts the error to an event
    let threw = false;
    let events: RunnerEvent[] = [];
    try {
      events = await drain(runBlueprint(blueprint, ctx, deps));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);

    // Exactly one error event
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toMatchObject({ type: 'error', message: 'node exploded' });

    // The status event before the throw was forwarded
    const statusEvents = events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({ type: 'status', text: 'about to fail' });

    // Later node did not run
    expect(laterNodeRan).toHaveLength(0);
  });
});

// ── runBlueprint — context threading ─────────────────────────────────────────

describe('runBlueprint — context threading', () => {
  it('a node can write ctx accumulators and a later node can read them', async () => {
    let readMarker: string | undefined;

    const writerNode: BlueprintNode<TestCtx, TestDeps> = {
      name: 'writer',
      kind: 'agentic',
      async *run(ctx: TestCtx): AsyncGenerator<RunnerEvent> {
        ctx.marker = 'hello from writer';
        yield { type: 'status', text: 'wrote ctx' };
      },
    };

    const readerNode: BlueprintNode<TestCtx, TestDeps> = {
      name: 'reader',
      kind: 'deterministic',
      async *run(ctx: TestCtx): AsyncGenerator<RunnerEvent> {
        readMarker = ctx.marker;
        yield { type: 'status', text: 'read ctx' };
      },
    };

    const blueprint: Blueprint<TestCtx, TestDeps> = { id: 'test', nodes: [writerNode, readerNode] };
    const ctx = makeCtx();
    const deps = makeDeps();

    await drain(runBlueprint(blueprint, ctx, deps));

    expect(readMarker).toBe('hello from writer');
  });
});

// ── boundedRetry combinator ───────────────────────────────────────────────────

describe('boundedRetry — no retry (decide returns false)', () => {
  it('runs the body exactly once when decide returns retry=false', async () => {
    const runCounts: number[] = [];
    const body = [makeCounterNode('body', runCounts)];

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 3,
      decide: async () => ({ retry: false }),
    });

    const events = await drain(node.run(makeCtx(), makeDeps()));

    expect(runCounts).toHaveLength(1);
    // Status from the single run
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);
    expect(statusTexts).toContain('body ran');
  });
});

describe('boundedRetry — always retry', () => {
  it('runs the body maxAttempts times when decide always returns retry=true', async () => {
    const runCounts: number[] = [];
    const body = [makeCounterNode('body', runCounts)];

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 3,
      decide: async () => ({ retry: true }),
    });

    await drain(node.run(makeCtx(), makeDeps()));

    expect(runCounts).toHaveLength(3);
  });
});

describe('boundedRetry — intermediate stop', () => {
  it('stops after attempt 0 (2 body runs total) when decide returns false on first call', async () => {
    const runCounts: number[] = [];
    const body = [makeCounterNode('body', runCounts)];
    let decideCalls = 0;

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 4,
      decide: async (_ctx, _deps, attempt) => {
        decideCalls++;
        // Retry once (after attempt 0), stop after attempt 1
        return { retry: attempt === 0 };
      },
    });

    await drain(node.run(makeCtx(), makeDeps()));

    // Body ran twice: attempt 0 (decide=retry) and attempt 1 (decide=stop)
    expect(runCounts).toHaveLength(2);
    expect(decideCalls).toBe(2);
  });
});

describe('boundedRetry — events forwarded every cycle', () => {
  it('forwards all body node events for every attempt', async () => {
    const body: BlueprintNode<TestCtx, TestDeps>[] = [
      {
        name: 'multi-event',
        kind: 'deterministic',
        async *run(): AsyncGenerator<RunnerEvent> {
          yield { type: 'status', text: 'first' };
          yield { type: 'status', text: 'second' };
        },
      },
    ];

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 2,
      decide: async () => ({ retry: true }),
    });

    const events = await drain(node.run(makeCtx(), makeDeps()));
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);

    // Two cycles × two events each = four status events
    expect(statusTexts).toEqual(['first', 'second', 'first', 'second']);
  });
});

describe('boundedRetry — decide status is yielded', () => {
  it('yields the decide status between cycles', async () => {
    const body = [makeCounterNode('body', [])];

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 2,
      decide: async () => ({ retry: true, status: 'retrying now…' }),
    });

    const events = await drain(node.run(makeCtx(), makeDeps()));
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);

    expect(statusTexts).toContain('retrying now…');
  });

  it('does not yield a status event when decide status is absent', async () => {
    const body = [makeCounterNode('body', [])];

    const node = boundedRetry<TestCtx, TestDeps>(body, {
      name: 'test-loop',
      maxAttempts: 2,
      decide: async () => ({ retry: false }),
    });

    const events = await drain(node.run(makeCtx(), makeDeps()));
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);

    // Only the body node's status; no extra decide status
    expect(statusTexts).toEqual(['body ran']);
  });
});

describe('boundedRetry — throwing body node propagates', () => {
  it('does not catch a body node throw; the error propagates to the caller', async () => {
    const throwingBody: BlueprintNode<TestCtx, TestDeps>[] = [
      {
        name: 'thrower',
        kind: 'deterministic',
        async *run(): AsyncGenerator<RunnerEvent> {
          yield { type: 'status', text: 'before throw' };
          throw new Error('body exploded');
        },
      },
    ];

    const node = boundedRetry<TestCtx, TestDeps>(throwingBody, {
      name: 'test-loop',
      maxAttempts: 3,
      decide: async () => ({ retry: true }),
    });

    let threw = false;
    let thrownMessage = '';
    try {
      await drain(node.run(makeCtx(), makeDeps()));
    } catch (err: unknown) {
      threw = true;
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(threw).toBe(true);
    expect(thrownMessage).toBe('body exploded');
  });
});

describe('boundedRetry — kind inference', () => {
  it('is agentic if any body node is agentic', () => {
    const body: BlueprintNode<TestCtx, TestDeps>[] = [
      { name: 'det', kind: 'deterministic', async *run() { /* empty */ } },
      { name: 'ag', kind: 'agentic', async *run() { /* empty */ } },
    ];
    const node = boundedRetry(body, {
      name: 'mixed-loop',
      maxAttempts: 1,
      decide: async () => ({ retry: false }),
    });
    expect(node.kind).toBe('agentic');
  });

  it('is deterministic if all body nodes are deterministic', () => {
    const body: BlueprintNode<TestCtx, TestDeps>[] = [
      { name: 'det', kind: 'deterministic', async *run() { /* empty */ } },
    ];
    const node = boundedRetry(body, {
      name: 'det-loop',
      maxAttempts: 1,
      decide: async () => ({ retry: false }),
    });
    expect(node.kind).toBe('deterministic');
  });
});

describe('boundedRetry — maxAttempts guard', () => {
  it('throws a RangeError when maxAttempts < 1 (catches misconfiguration early)', () => {
    const body: BlueprintNode<TestCtx, TestDeps>[] = [
      { name: 'det', kind: 'deterministic', async *run() { /* empty */ } },
    ];
    expect(() =>
      boundedRetry(body, { name: 'bad', maxAttempts: 0, decide: async () => ({ retry: false }) }),
    ).toThrow(RangeError);
  });
});

// ── blueprintFor registry ─────────────────────────────────────────────────────

describe('blueprintFor registry', () => {
  it('returns a blueprint with the seven expected node names in order', () => {
    const bp = blueprintFor('repo-oneshot');
    const names = bp.nodes.map((n) => n.name);
    expect(names).toEqual(['clone', 'research', 'plan', 'branch', 'implement-check-loop', 'push', 'open-pr']);
  });

  it('throws for an unknown blueprint id', () => {
    expect(() => blueprintFor('nope')).toThrow('no blueprint for id "nope"');
  });

  it('returns the same blueprint object as repoOneshot', () => {
    expect(blueprintFor('repo-oneshot')).toBe(repoOneshot);
  });
});

// ── repoOneshot node kinds ────────────────────────────────────────────────────

describe('repoOneshot node kinds', () => {
  it('research, plan, implement-check-loop are agentic; all others are deterministic', () => {
    const kindsByName = Object.fromEntries(
      repoOneshot.nodes.map((n) => [n.name, n.kind]),
    );
    expect(kindsByName['clone']).toBe('deterministic');
    expect(kindsByName['research']).toBe('agentic');
    expect(kindsByName['plan']).toBe('agentic');
    expect(kindsByName['branch']).toBe('deterministic');
    expect(kindsByName['implement-check-loop']).toBe('agentic');
    expect(kindsByName['push']).toBe('deterministic');
    expect(kindsByName['open-pr']).toBe('deterministic');
  });
});
