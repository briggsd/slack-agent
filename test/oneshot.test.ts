/**
 * Tests for M5 S02: one-shot orchestrator + profile dispatch + task parser.
 *
 * Everything here is fully offline — no Docker, no network, no API.
 * Uses FakeBroker, FakeRunner/FakeRunnerFactory, FakeGitNodeExecutor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeBroker } from '../src/broker/fake.js';
import { BotAccountBroker } from '../src/broker/bot-account.js';
import { FakeRunner, FakeRunnerFactory } from '../src/runner/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import { parseOneShotTask } from '../src/oneshot/parse.js';
import { OneShotOrchestrator } from '../src/oneshot/orchestrator.js';
import { DispatchingRunnerFactory } from '../src/oneshot/dispatching-factory.js';
import { getProfile } from '../src/profiles/registry.js';
import { volumeNameFor } from '../src/runner/docker.js';
import type { RunnerEvent } from '../src/runner/types.js';
import type { CredentialBroker, LeaseRequest, CredentialLease } from '../src/broker/types.js';

const TEST_SESSION_KEY = 'TEAM01:C123:T456';

// Helper: drain an AsyncIterable<RunnerEvent> into an array
async function drain(iter: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

// ── parseOneShotTask ──────────────────────────────────────────────────────────

describe('parseOneShotTask', () => {
  it('parses a valid github task', () => {
    const result = parseOneShotTask('github:acme/widgets add a CHANGELOG');
    expect(result).not.toBeNull();
    expect(result?.host).toBe('github');
    expect(result?.repo).toBe('acme/widgets');
    expect(result?.instruction).toBe('add a CHANGELOG');
  });

  it('parses a valid gitlab task', () => {
    const result = parseOneShotTask('gitlab:myorg/myrepo fix the bug');
    expect(result).not.toBeNull();
    expect(result?.host).toBe('gitlab');
    expect(result?.repo).toBe('myorg/myrepo');
    expect(result?.instruction).toBe('fix the bug');
  });

  it('returns null for an unknown host', () => {
    expect(parseOneShotTask('bitbucket:acme/widgets do something')).toBeNull();
  });

  it('returns null when repo slug is missing', () => {
    expect(parseOneShotTask('github: do something')).toBeNull();
  });

  it('returns null when instruction is missing', () => {
    expect(parseOneShotTask('github:acme/widgets')).toBeNull();
  });

  it('returns null for a completely malformed message', () => {
    expect(parseOneShotTask('just some text')).toBeNull();
    expect(parseOneShotTask('')).toBeNull();
  });

  it('trims leading/trailing whitespace from the message', () => {
    const result = parseOneShotTask('  github:acme/repo update readme  ');
    expect(result?.host).toBe('github');
    expect(result?.repo).toBe('acme/repo');
    expect(result?.instruction).toBe('update readme');
  });

  it('handles multi-word instructions', () => {
    const result = parseOneShotTask('github:org/name add CHANGELOG and bump version');
    expect(result?.instruction).toBe('add CHANGELOG and bump version');
  });

  it('rejects repo slugs that attempt path traversal', () => {
    expect(parseOneShotTask('github:a/../../etc do something')).toBeNull();
    expect(parseOneShotTask('github:../escape do something')).toBeNull();
    expect(parseOneShotTask('github:owner/.. do something')).toBeNull();
  });

  it('rejects a bare owner with no name segment', () => {
    expect(parseOneShotTask('github:owner do something')).toBeNull();
  });

  it('accepts GitLab subgroup slugs (group/subgroup/project)', () => {
    const result = parseOneShotTask('gitlab:group/sub/proj fix it');
    expect(result?.host).toBe('gitlab');
    expect(result?.repo).toBe('group/sub/proj');
    expect(result?.instruction).toBe('fix it');
  });
});

// ── OneShotOrchestrator — happy path ─────────────────────────────────────────

describe('OneShotOrchestrator — happy path', () => {
  let broker: FakeBroker;
  let gitNodes: FakeGitNodeExecutor;
  let innerRunner: FakeRunner;
  let orch: OneShotOrchestrator;

  beforeEach(() => {
    broker = new FakeBroker();
    gitNodes = new FakeGitNodeExecutor('https://example.test/pr/42');
    // Script three agentic turns: research, plan, implement — each with a distinct final text
    innerRunner = new FakeRunner('test-session', [
      [
        { type: 'status', text: 'running tool…' },
        { type: 'text', text: 'research done' },
      ],
      [
        { type: 'text', text: 'plan done' },
      ],
      [
        { type: 'status', text: 'running tool…' },
        { type: 'text', text: 'impl done' },
      ],
    ]);
    orch = new OneShotOrchestrator(innerRunner, broker, gitNodes, TEST_SESSION_KEY, 'task-001');
  });

  it('runs the full blueprint in order and emits terminal text with PR url', async () => {
    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    // Collect status texts in order
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);

    expect(statusTexts).toContain('cloning repository…');
    expect(statusTexts).toContain('researching…');
    expect(statusTexts).toContain('planning…');
    expect(statusTexts).toContain('creating branch…');
    expect(statusTexts).toContain('implementing…');
    expect(statusTexts).toContain('running tool…'); // forwarded inner status
    expect(statusTexts).toContain('linting…');
    expect(statusTexts).toContain('testing…');
    expect(statusTexts).toContain('pushing branch…');
    expect(statusTexts).toContain('opening pull request…');

    // Verify status ordering: clone < research < plan < branch < implement < lint < test < push < PR
    const cloneIdx = statusTexts.indexOf('cloning repository…');
    const researchIdx = statusTexts.indexOf('researching…');
    const planIdx = statusTexts.indexOf('planning…');
    const branchIdx = statusTexts.indexOf('creating branch…');
    const implIdx = statusTexts.indexOf('implementing…');
    const lintIdx = statusTexts.indexOf('linting…');
    const testIdx = statusTexts.indexOf('testing…');
    const pushIdx = statusTexts.indexOf('pushing branch…');
    const prIdx = statusTexts.indexOf('opening pull request…');
    expect(cloneIdx).toBeLessThan(researchIdx);
    expect(researchIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(branchIdx);
    expect(branchIdx).toBeLessThan(implIdx);
    expect(implIdx).toBeLessThan(lintIdx);
    expect(lintIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(prIdx);

    // Terminal text contains the PR url
    const textEvents = events.filter((e): e is { type: 'text'; text: string } => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toContain('https://example.test/pr/42');
    expect(textEvents[0]?.text).toContain('Opened PR:');

    // No error events
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('records two runCheck calls (lint then test) with correct workdir and volume', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    expect(gitNodes.checks).toHaveLength(2);
    expect(gitNodes.checks[0]?.kind).toBe('lint');
    expect(gitNodes.checks[0]?.workdir).toBe('/workspace/acme-widgets');
    expect(gitNodes.checks[1]?.kind).toBe('test');
    expect(gitNodes.checks[1]?.workdir).toBe('/workspace/acme-widgets');

    // Both checks should have the correct volume
    const expectedVolume = (await import('../src/runner/docker.js')).volumeNameFor(TEST_SESSION_KEY);
    expect(gitNodes.checks[0]?.volume).toBe(expectedVolume);
    expect(gitNodes.checks[1]?.volume).toBe(expectedVolume);
  });

  it('leases once and revokes once', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]?.host).toBe('github');
    expect(broker.leases[0]?.repo).toBe('acme/widgets');
    expect(broker.leases[0]?.taskId).toBe('task-001');
    expect(broker.revokes).toHaveLength(1);
  });

  it('sends three prompts to the inner runner in order (research, plan, implement)', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));
    expect(innerRunner.sends).toHaveLength(3);

    // research prompt: contains workdir and instruction
    const researchSent = innerRunner.sends[0] ?? '';
    expect(researchSent).toContain('/workspace/acme-widgets');
    expect(researchSent).toContain('add a CHANGELOG');

    // plan prompt: the planning directive (no workdir needed — agent already has context)
    const planSent = innerRunner.sends[1] ?? '';
    expect(planSent.toLowerCase()).toContain('plan');

    // implement prompt: contains workdir and commit instruction
    const implSent = innerRunner.sends[2] ?? '';
    expect(implSent).toContain('/workspace/acme-widgets');
    expect(implSent.toLowerCase()).toContain('commit');
    // Positional indices above already pin both count and order (research, plan, implement).
  });

  it('records clone, branch, push, and openChangeRequest calls', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));
    expect(gitNodes.clones).toHaveLength(1);
    expect(gitNodes.clones[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.branches).toHaveLength(1);
    expect(gitNodes.branches[0]?.branch).toContain('slackbot/oneshot-');
    expect(gitNodes.branches[0]?.workdir).toBe('/workspace/acme-widgets');
    expect(gitNodes.branches[0]?.volume).toBe(volumeNameFor(TEST_SESSION_KEY));
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.pushes[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.pushes[0]?.branch).toContain('slackbot/oneshot-');
    expect(gitNodes.changeRequests).toHaveLength(1);
    expect(gitNodes.changeRequests[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.changeRequests[0]?.base).toBe('main');
  });

  it('threads volumeNameFor(sessionKey) into clone and push requests', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));
    const expectedVolume = volumeNameFor(TEST_SESSION_KEY);
    expect(gitNodes.clones[0]?.volume).toBe(expectedVolume);
    expect(gitNodes.pushes[0]?.volume).toBe(expectedVolume);
  });

  it('the PR title is derived from the instruction (first 72 chars)', async () => {
    await drain(orch.send('github:acme/widgets add a CHANGELOG'));
    expect(gitNodes.changeRequests[0]?.title).toBe('add a CHANGELOG');
  });
});

// ── OneShotOrchestrator — non-gating checks ──────────────────────────────────

describe('OneShotOrchestrator — non-gating checks', () => {
  it('a failing lint check does NOT block push or openChangeRequest — PR still opens', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://example.test/pr/99');
    // Script lint to fail
    gitNodes.setCheckResult('lint', { exitCode: 1, output: 'boom', skipped: false });

    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-nongating');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    // Push and openChangeRequest still called despite lint failure
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.changeRequests).toHaveLength(1);

    // Terminal text contains PR url
    const textEvents = events.filter((e): e is { type: 'text'; text: string } => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toContain('Opened PR:');
    expect(textEvents[0]?.text).toContain('https://example.test/pr/99');

    // No error events (the failed lint is surfaced as a status, not an error)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    // The lint failure status appears
    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);
    expect(statusTexts).toContain('lint failed (surfaced; not blocking until the retry loop lands)');
  });

  it('a skipped check reports "skipped", not "passed", and the PR still opens', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://example.test/pr/100');
    // Auto-detect found nothing to run for both checks.
    gitNodes.setCheckResult('lint', { exitCode: 0, output: '', skipped: true });
    gitNodes.setCheckResult('test', { exitCode: 0, output: '', skipped: true });

    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-skipped');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);
    expect(statusTexts).toContain('lint skipped (no command)');
    expect(statusTexts).toContain('tests skipped (no command)');
    expect(statusTexts).not.toContain('lint passed');
    expect(statusTexts).not.toContain('tests passed');

    // A skip is not a failure — the PR still opens.
    expect(gitNodes.changeRequests).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — parse failure ──────────────────────────────────────

describe('OneShotOrchestrator — parse failure', () => {
  let broker: FakeBroker;
  let gitNodes: FakeGitNodeExecutor;
  let orch: OneShotOrchestrator;

  beforeEach(() => {
    broker = new FakeBroker();
    gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session');
    orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-002');
  });

  it('emits a single error event and makes no lease or git calls', async () => {
    const events = await drain(orch.send('not a valid task format'));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');

    // No lease, no git calls
    expect(broker.leases).toHaveLength(0);
    expect(broker.revokes).toHaveLength(0);
    expect(gitNodes.clones).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });

  it('emits error for unknown host', async () => {
    const events = await drain(orch.send('bitbucket:acme/repo do something'));
    expect(events[0]?.type).toBe('error');
    expect(broker.leases).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — post-lease git failure ──────────────────────────────

describe('OneShotOrchestrator — post-lease git failure', () => {
  it('revokes the lease and emits error when push rejects', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextPush(new Error('push failed: auth denied'));
    // Three agentic turns succeed (research, plan, implement); push then fails
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-003');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    // Lease acquired and revoked
    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);

    // Terminal event is an error
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);

    // No text event (no PR url)
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });

  it('revokes the lease and emits error when openChangeRequest rejects', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextOpenChange(new Error('API rate limit'));
    // Three agentic turns succeed; openChangeRequest then fails
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-004');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — branch failure ─────────────────────────────────────

describe('OneShotOrchestrator — branch failure', () => {
  it('revokes the lease and emits error when branch rejects', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextBranch(new Error('branch failed: no such workdir'));
    // Research and plan succeed before branch fails; implement is never reached
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-branch-fail');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    // Lease acquired and revoked exactly once
    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);

    // Terminal event is an error
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);

    // Branch fails before implement — inner runner was only sent research and plan (2 sends)
    expect(inner.sends).toHaveLength(2);

    // No text event (no PR url)
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);

    // No push or openChangeRequest calls
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — inner agent error ───────────────────────────────────

describe('OneShotOrchestrator — inner agent error', () => {
  it('revokes the lease and emits error when inner agent emits error event', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session', [
      // Script the research turn to emit an error
      [{ type: 'error', message: 'agent crashed' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-005');

    const events = await drain(orch.send('github:acme/widgets add something'));

    // Lease was acquired and revoked
    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);

    // No push, no PR
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);

    // Terminal event is error
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — research failure ────────────────────────────────────

describe('OneShotOrchestrator — research failure', () => {
  it('revokes the lease, emits one error, and skips plan/implement/branch/push/pr', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session', [
      // Script the research turn to emit an error event
      [{ type: 'error', message: 'research failed: sandbox timeout' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-research-fail');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    // Lease acquired and revoked exactly once
    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);

    // Single terminal error event
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);

    // Only research was attempted — sends has length 1
    expect(inner.sends).toHaveLength(1);

    // No branch, push, or openChangeRequest calls
    expect(gitNodes.branches).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — plan failure ────────────────────────────────────────

describe('OneShotOrchestrator — plan failure', () => {
  it('research succeeds, plan errors → lease revoked once, no implement/branch/push/pr', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      // plan turn errors
      [{ type: 'error', message: 'plan failed: model overloaded' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-plan-fail');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);

    // Research and plan were attempted (2 sends); implement was never reached.
    expect(inner.sends).toHaveLength(2);

    // Plan fails before branch — no deterministic git work happened.
    expect(gitNodes.branches).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — implement failure ───────────────────────────────────

describe('OneShotOrchestrator — implement failure', () => {
  it('research+plan+branch succeed, implement errors → lease revoked once, no push/pr', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      // implement turn errors
      [{ type: 'error', message: 'implement failed: agent crashed' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-impl-fail');

    const events = await drain(orch.send('github:acme/widgets add a CHANGELOG'));

    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);

    // All three agentic turns were attempted.
    expect(inner.sends).toHaveLength(3);

    // Branch ran (it precedes implement); push/PR did not (implement failed first).
    expect(gitNodes.branches).toHaveLength(1);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — lease failure ──────────────────────────────────────

describe('OneShotOrchestrator — lease failure', () => {
  it('emits an error event (not an uncaught rejection) when lease() rejects', async () => {
    // BotAccountBroker with no tokens throws for any host — a realistic reject.
    const broker = new BotAccountBroker(new Map());
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session');
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-lease');

    const events = await drain(orch.send('github:acme/widgets do something'));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    // No git work attempted without a lease.
    expect(gitNodes.clones).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── OneShotOrchestrator — revoke resilience ──────────────────────────────────

describe('OneShotOrchestrator — revoke resilience', () => {
  // A broker whose lease.revoke() throws, and counts how many times it is called.
  class ThrowingRevokeBroker implements CredentialBroker {
    public revokeCalls = 0;
    async lease(req: LeaseRequest): Promise<CredentialLease> {
      return {
        token: 'fake',
        host: req.host,
        repo: req.repo,
        revoke: async (): Promise<void> => {
          this.revokeCalls += 1;
          throw new Error('revoke failed');
        },
      };
    }
  }

  it('a throwing revoke does not crash the turn and the PR is still reported', async () => {
    const broker = new ThrowingRevokeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://example.test/pr/7');
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-revoke');

    const events = await drain(orch.send('github:acme/widgets add x'));

    // Success still surfaces despite the revoke throwing…
    const textEvents = events.filter((e): e is { type: 'text'; text: string } => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toContain('https://example.test/pr/7');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    // …and revoke was attempted exactly once (the guard prevents a double call).
    expect(broker.revokeCalls).toBe(1);
  });
});

// ── OneShotOrchestrator — workdir safety ─────────────────────────────────────

describe('OneShotOrchestrator — workdir', () => {
  it('collapses all repo-slug slashes so the clone workdir is a single path segment', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session', [
      [{ type: 'text', text: 'research done' }],
      [{ type: 'text', text: 'plan done' }],
      [{ type: 'text', text: 'impl done' }],
    ]);
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-wd');

    await drain(orch.send('gitlab:group/sub/proj fix it'));

    expect(gitNodes.clones[0]?.workdir).toBe('/workspace/group-sub-proj');
  });
});

// ── OneShotOrchestrator — dispose ────────────────────────────────────────────

describe('OneShotOrchestrator — dispose', () => {
  it('dispose() disposes the inner runner', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session');
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-006');

    expect(inner.disposed).toBe(false);
    await orch.dispose();
    expect(inner.disposed).toBe(true);
  });

  it('dispose() is idempotent', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const inner = new FakeRunner('test-session');
    const orch = new OneShotOrchestrator(inner, broker, gitNodes, TEST_SESSION_KEY, 'task-007');

    await orch.dispose();
    await orch.dispose(); // second call must not throw
    expect(inner.disposed).toBe(true);
  });
});

// ── DispatchingRunnerFactory ──────────────────────────────────────────────────

describe('DispatchingRunnerFactory', () => {
  it('returns a OneShotOrchestrator for the repo-oneshot profile', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const baseFactory = new FakeRunnerFactory();
    const dispatchFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

    const oneShotProfile = getProfile('repo-oneshot');
    const runner = await dispatchFactory.create('TEAM:C:T', oneShotProfile);

    expect(runner).toBeInstanceOf(OneShotOrchestrator);
  });

  it('creates the inner runner with the conversational profile (no dispatch recursion)', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const baseFactory = new FakeRunnerFactory();
    const dispatchFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

    const oneShotProfile = getProfile('repo-oneshot');
    await dispatchFactory.create('TEAM:C:T', oneShotProfile);

    // The base factory was called once (for the inner runner)
    expect(baseFactory.creates).toHaveLength(1);
    expect(baseFactory.profiles).toHaveLength(1);
    // Inner runner was created with the conversational profile, not one-shot
    expect(baseFactory.profiles[0]?.id).toBe('conversational');
    expect(baseFactory.profiles[0]?.mode).toBe('conversational');
  });

  it('delegates to the base factory for conversational profile', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const baseFactory = new FakeRunnerFactory();
    const dispatchFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

    const convProfile = getProfile('conversational');
    const runner = await dispatchFactory.create('TEAM:C:T', convProfile);

    // Should be a FakeRunner (from base factory), not a OneShotOrchestrator
    expect(runner).not.toBeInstanceOf(OneShotOrchestrator);
    expect(runner).toBeInstanceOf(FakeRunner);

    // Base factory called once with the conversational profile
    expect(baseFactory.creates).toHaveLength(1);
    expect(baseFactory.profiles[0]?.id).toBe('conversational');
  });

  it('does not recursively dispatch — inner runner is made by base factory', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const baseFactory = new FakeRunnerFactory();
    const dispatchFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

    const oneShotProfile = getProfile('repo-oneshot');
    // Create two one-shot sessions
    await dispatchFactory.create('TEAM:C:T1', oneShotProfile);
    await dispatchFactory.create('TEAM:C:T2', oneShotProfile);

    // Base factory called exactly twice (once per one-shot session for the inner runner)
    // If there were recursion, it would be called more times.
    expect(baseFactory.creates).toHaveLength(2);
    // All inner runners are conversational
    expect(baseFactory.profiles.every((p) => p.mode === 'conversational')).toBe(true);
  });
});
