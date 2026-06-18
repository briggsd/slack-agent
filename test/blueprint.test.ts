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
import { blueprintFor } from '../src/oneshot/registry.js';
import { repoOneshot } from '../src/oneshot/repo-oneshot.js';

// ── Engine test stub types ────────────────────────────────────────────────────

interface TestCtx {
  marker?: string;
}

interface TestDeps {}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(gen: AsyncGenerator<RunnerEvent>): Promise<RunnerEvent[]> {
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

// ── blueprintFor registry ─────────────────────────────────────────────────────

describe('blueprintFor registry', () => {
  it('returns a blueprint with the seven expected node names in order', () => {
    const bp = blueprintFor('repo-oneshot');
    const names = bp.nodes.map((n) => n.name);
    expect(names).toEqual(['clone', 'research', 'plan', 'branch', 'implement', 'push', 'open-pr']);
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
  it('research, plan, implement are agentic; all others are deterministic', () => {
    const kindsByName = Object.fromEntries(
      repoOneshot.nodes.map((n) => [n.name, n.kind]),
    );
    expect(kindsByName['clone']).toBe('deterministic');
    expect(kindsByName['research']).toBe('agentic');
    expect(kindsByName['plan']).toBe('agentic');
    expect(kindsByName['branch']).toBe('deterministic');
    expect(kindsByName['implement']).toBe('agentic');
    expect(kindsByName['push']).toBe('deterministic');
    expect(kindsByName['open-pr']).toBe('deterministic');
  });
});
