/**
 * Tests for the M5 S04a blueprint framework.
 *
 * These tests exercise the framework independently of the specific one-shot
 * nodes, using tiny stub nodes. Everything is fully offline — no Docker,
 * no network, no API.
 */

import { describe, it, expect } from 'vitest';
import type { BlueprintNode, BlueprintContext, NodeDeps, Blueprint } from '../src/oneshot/blueprints/types.js';
import type { RunnerEvent } from '../src/runner/types.js';
import { runBlueprint } from '../src/oneshot/executor.js';
import { blueprintFor } from '../src/oneshot/blueprints/registry.js';
import { repoOneshot } from '../src/oneshot/blueprints/repo-oneshot.js';
import { FakeRunner } from '../src/runner/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import { FakeBroker } from '../src/broker/fake.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(gen: AsyncGenerator<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

function makeDeps(): NodeDeps {
  return {
    inner: new FakeRunner('test-session'),
    gitNodes: new FakeGitNodeExecutor(),
  };
}

async function makeCtx(overrides?: Partial<BlueprintContext>): Promise<BlueprintContext> {
  const broker = new FakeBroker();
  const lease = await broker.lease({ host: 'github', repo: 'acme/widgets', taskId: 'test' });
  return {
    host: 'github',
    repo: 'acme/widgets',
    instruction: 'add a CHANGELOG',
    taskId: 'test-task',
    volume: 'slackbot-ws-test',
    workdir: '/workspace/acme-widgets',
    branch: 'slackbot/oneshot-test-task',
    lease,
    ...overrides,
  };
}

// ── runBlueprint — node ordering ─────────────────────────────────────────────

describe('runBlueprint — node ordering', () => {
  it('runs nodes in order and forwards their events', async () => {
    const calls: string[] = [];

    const nodeA: BlueprintNode = {
      name: 'node-a',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('a-start');
        yield { type: 'status', text: 'a running' };
        calls.push('a-end');
      },
    };

    const nodeB: BlueprintNode = {
      name: 'node-b',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('b-start');
        yield { type: 'status', text: 'b running' };
        calls.push('b-end');
      },
    };

    const nodeC: BlueprintNode = {
      name: 'node-c',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        calls.push('c-start');
        yield { type: 'status', text: 'c running' };
        calls.push('c-end');
      },
    };

    const blueprint: Blueprint = { id: 'test', nodes: [nodeA, nodeB, nodeC] };
    const ctx = await makeCtx();
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

    const failingNode: BlueprintNode = {
      name: 'failing',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        yield { type: 'status', text: 'about to fail' };
        throw new Error('node exploded');
      },
    };

    const laterNode: BlueprintNode = {
      name: 'later',
      kind: 'deterministic',
      async *run(): AsyncGenerator<RunnerEvent> {
        laterNodeRan.push(true);
        yield { type: 'status', text: 'later ran' };
      },
    };

    const blueprint: Blueprint = { id: 'test', nodes: [failingNode, laterNode] };
    const ctx = await makeCtx();
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
    let readSummary: string | undefined;
    let readPrUrl: string | undefined;

    const writerNode: BlueprintNode = {
      name: 'writer',
      kind: 'agentic',
      async *run(ctx: BlueprintContext): AsyncGenerator<RunnerEvent> {
        ctx.implementSummary = 'summary from writer';
        ctx.prUrl = 'https://example.test/pr/99';
        yield { type: 'status', text: 'wrote ctx' };
      },
    };

    const readerNode: BlueprintNode = {
      name: 'reader',
      kind: 'deterministic',
      async *run(ctx: BlueprintContext): AsyncGenerator<RunnerEvent> {
        readSummary = ctx.implementSummary;
        readPrUrl = ctx.prUrl;
        yield { type: 'status', text: 'read ctx' };
      },
    };

    const blueprint: Blueprint = { id: 'test', nodes: [writerNode, readerNode] };
    const ctx = await makeCtx();
    const deps = makeDeps();

    await drain(runBlueprint(blueprint, ctx, deps));

    expect(readSummary).toBe('summary from writer');
    expect(readPrUrl).toBe('https://example.test/pr/99');
  });
});

// ── blueprintFor registry ─────────────────────────────────────────────────────

describe('blueprintFor registry', () => {
  it('returns a blueprint with the four expected node names in order', () => {
    const bp = blueprintFor('repo-oneshot');
    const names = bp.nodes.map((n) => n.name);
    expect(names).toEqual(['clone', 'implement', 'push', 'open-pr']);
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
  it('only implementNode is agentic; all others are deterministic', () => {
    const kindsByName = Object.fromEntries(
      repoOneshot.nodes.map((n) => [n.name, n.kind]),
    );
    expect(kindsByName['clone']).toBe('deterministic');
    expect(kindsByName['implement']).toBe('agentic');
    expect(kindsByName['push']).toBe('deterministic');
    expect(kindsByName['open-pr']).toBe('deterministic');
  });
});
