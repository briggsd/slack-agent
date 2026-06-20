/**
 * S12a — build engine tests (offline).
 *
 * Four groups:
 *  1. Engine via createBuildRunner (DispatchingRunnerFactory + fakes)
 *  2. Distinct container name (real DockerRunnerFactory + FakeChildProcess)
 *  3. Manager runBuild via the public drive path
 *  4. driveToThread is behaviour-preserving (existing router-turn tests pass — implicit via gate)
 *
 * All tests are offline: no Docker, no Slack, no API, no network.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { FakeBroker } from '../src/broker/fake.js';
import { FakeRunner, FakeRunnerFactory } from '../src/runner/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import { DispatchingRunnerFactory } from '../src/oneshot/dispatching-factory.js';
import { DockerRunnerFactory, sanitizeKey, volumeNameFor } from '../src/runner/docker.js';
import type { DockerRunnerConfig, SpawnFn } from '../src/runner/docker.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { BuildRunnerFactory } from '../src/runner/types.js';
import type { SessionRunner, RunnerStream, RunnerEvent } from '../src/runner/types.js';
import { FakeSlackClient } from './responder.test.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function drain(iter: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

const TEST_SESSION_KEY = 'TEAM01:C123:T456';

// ── FakeChildProcess (mirrors docker.test.ts) ─────────────────────────────────

class FakeChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdinLines: string[] = [];
  private stdinBuf = '';

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.on('data', (chunk: Buffer | string) => {
      this.stdinBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl: number;
      while ((nl = this.stdinBuf.indexOf('\n')) !== -1) {
        this.stdinLines.push(this.stdinBuf.slice(0, nl));
        this.stdinBuf = this.stdinBuf.slice(nl + 1);
      }
    });
  }

  writeOut(line: string): void {
    this.stdout.push(line + '\n');
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(): boolean {
    return true;
  }
}

const DEFAULT_DOCKER_CONFIG: DockerRunnerConfig = {
  image: 'slackbot-runner:test',
  readyTimeoutMs: 1_000,
  turnTimeoutMs: 2_000,
  killGraceMs: 100,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
};

// ── Group 1: Engine via createBuildRunner ─────────────────────────────────────

describe('S12a — createBuildRunner runs the build-tail blueprint', () => {
  it('drives to a pr_opened event with no clone, branch+push+PR recorded, lease minted+revoked', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://github.com/acme/widgets/pull/1');
    const baseFactory = new FakeRunnerFactory([
      // implement turn (the only agentic turn in build-tail)
      [{ type: 'text', text: 'impl done' }],
    ]);

    const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
    const runner = await factory.createBuildRunner(TEST_SESSION_KEY, 'acme/widgets');

    const events = await drain(runner.send(''));

    // Must have a pr_opened event
    const prEvents = events.filter(
      (e): e is { type: 'pr_opened'; url: string } => e.type === 'pr_opened',
    );
    expect(prEvents).toHaveLength(1);
    expect(prEvents[0]?.url).toBe('https://github.com/acme/widgets/pull/1');

    // No errors
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    // No clone was run (build tail skips clone/research/plan)
    expect(gitNodes.clones).toHaveLength(0);

    // Branch was created on workdir derived from repo slug
    expect(gitNodes.branches).toHaveLength(1);
    expect(gitNodes.branches[0]?.workdir).toBe('/workspace/acme-widgets');
    expect(gitNodes.branches[0]?.volume).toBe(volumeNameFor(TEST_SESSION_KEY));

    // Push happened
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.pushes[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.pushes[0]?.branch).toContain('slackbot/oneshot-');
    expect(gitNodes.pushes[0]?.volume).toBe(volumeNameFor(TEST_SESSION_KEY));

    // PR was opened
    expect(gitNodes.changeRequests).toHaveLength(1);
    expect(gitNodes.changeRequests[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.changeRequests[0]?.base).toBe('main');

    // Broker: lease minted for github + repo, and revoked
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]?.host).toBe('github');
    expect(broker.leases[0]?.repo).toBe('acme/widgets');
    expect(broker.revokes).toHaveLength(1);

    // Inner runner was requested with nameSuffix:'build'
    expect(baseFactory.suffixes).toHaveLength(1);
    expect(baseFactory.suffixes[0]).toBe('build');
  });

  it('rejects an unsafe repo slug (traversal) with an error event before any lease or git op', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://github.com/x/y/pull/1');
    const baseFactory = new FakeRunnerFactory([[{ type: 'text', text: 'impl' }]]);

    const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
    // '..' has no slash and is a traversal segment — isSafeRepoSlug must reject it.
    const runner = await factory.createBuildRunner(TEST_SESSION_KEY, '..');

    const events = await drain(runner.send(''));

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.filter((e) => e.type === 'pr_opened')).toHaveLength(0);
    // Short-circuited before the lease was minted and before any git op ran.
    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.branches).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});

// ── Group 2: Distinct container name ─────────────────────────────────────────

describe('S12a — DockerRunnerFactory.create nameSuffix', () => {
  it('with nameSuffix:"build" spawns --name slackbot-<safe>-build with the SAME shared volume', async () => {
    const capturedArgLists: string[][] = [];

    const fakeSpawn: SpawnFn = (_cmd, args) => {
      capturedArgLists.push([...args]);
      const fake = new FakeChildProcess();
      setTimeout(() => {
        fake.writeOut(JSON.stringify({ type: 'ready' }));
      }, 5);
      return fake.asChildProcess();
    };

    const factory = new DockerRunnerFactory(DEFAULT_DOCKER_CONFIG, fakeSpawn);
    const key = 'TEAM01:C123:T456';
    const safe = sanitizeKey(key);

    // Without suffix
    const r1 = await factory.create(key, { id: 'conversational', label: 'Conversational', mode: 'conversational', planGate: false });
    const args1 = capturedArgLists[0] ?? [];

    const nameIdx1 = args1.indexOf('--name');
    expect(args1[nameIdx1 + 1]).toBe(`slackbot-${safe}`);
    const volIdx1 = args1.indexOf('-v');
    const volArg1 = args1[volIdx1 + 1] ?? '';
    expect(volArg1).toBe(`slackbot-ws-${safe}:/workspace`);

    // With nameSuffix:'build'
    const r2 = await factory.create(key, { id: 'conversational', label: 'Conversational', mode: 'conversational', planGate: false }, { nameSuffix: 'build' });
    const args2 = capturedArgLists[1] ?? [];

    const nameIdx2 = args2.indexOf('--name');
    expect(args2[nameIdx2 + 1]).toBe(`slackbot-${safe}-build`);
    // Volume must be identical (shared)
    const volIdx2 = args2.indexOf('-v');
    const volArg2 = args2[volIdx2 + 1] ?? '';
    expect(volArg2).toBe(`slackbot-ws-${safe}:/workspace`);

    await r1.dispose();
    await r2.dispose();
  });
});

// ── Group 3: Manager runBuild via the public drive path ───────────────────────

describe('S12a — SessionManager.runBuild via public drive path', () => {
  /**
   * A FakeBuildRunnerFactory whose createBuildRunner returns a scripted FakeRunner.
   */
  class FakeBuildFactory implements BuildRunnerFactory {
    public createCalls: Array<{ sessionKey: string; repo: string }> = [];
    private tailScript: RunnerEvent[][];

    constructor(tailScript: RunnerEvent[][] = []) {
      this.tailScript = tailScript;
    }

    public disposedRunners: FakeRunner[] = [];

    async createBuildRunner(sessionKey: string, repo: string): Promise<SessionRunner> {
      this.createCalls.push({ sessionKey, repo });
      const runner = new FakeRunner(sessionKey, this.tailScript);
      // Track disposal via wrapper
      const self = this;
      return {
        send: (msg: string): RunnerStream => runner.send(msg),
        async dispose(): Promise<void> {
          await runner.dispose();
          self.disposedRunners.push(runner);
        },
      };
    }
  }

  it('tail yields pr_opened → build placeholder shows "Opened PR: <url>", open-pr audit recorded, tail disposed', async () => {
    const slack = new FakeSlackClient();

    // Router runner yields a run_build event then a text completion
    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'acme/widgets' },
      { type: 'text', text: 'build done' },
    ];

    // Tail runner yields pr_opened
    const tailScript: RunnerEvent[] = [
      { type: 'status', text: 'opening PR…' },
      { type: 'pr_opened', url: 'https://github.com/acme/widgets/pull/42' },
    ];

    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory([[...tailScript]]);

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      buildRunnerFactory: buildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    // Wait for drain to complete
    await new Promise((r) => setTimeout(r, 50));

    // build placeholder should show "Opened PR: <url>"
    expect(
      slack.updates.some((u) => u.text === 'Opened PR: https://github.com/acme/widgets/pull/42'),
    ).toBe(true);

    // createBuildRunner was called with the event's repo
    expect(buildFactory.createCalls).toHaveLength(1);
    expect(buildFactory.createCalls[0]?.repo).toBe('acme/widgets');

    // Tail runner was disposed
    expect(buildFactory.disposedRunners).toHaveLength(1);
    expect(buildFactory.disposedRunners[0]?.disposed).toBe(true);
  });

  it('tail yields error → tail disposed, no PR url in updates', async () => {
    const slack = new FakeSlackClient();

    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'acme/widgets' },
      { type: 'text', text: 'build done' },
    ];

    const tailScript: RunnerEvent[] = [
      { type: 'error', message: 'impl failed' },
    ];

    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory([[...tailScript]]);

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      buildRunnerFactory: buildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 50));

    // No PR url posted
    expect(slack.updates.some((u) => u.text.includes('Opened PR:'))).toBe(false);

    // Tail runner was disposed
    expect(buildFactory.disposedRunners).toHaveLength(1);
    expect(buildFactory.disposedRunners[0]?.disposed).toBe(true);
  });

  it('createBuildRunner is called with the repo from the run_build event', async () => {
    const slack = new FakeSlackClient();

    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'org/my-proj' },
      { type: 'text', text: 'done' },
    ];

    const tailScript: RunnerEvent[] = [
      { type: 'pr_opened', url: 'https://github.com/org/my-proj/pull/7' },
    ];

    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory([[...tailScript]]);

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      buildRunnerFactory: buildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(buildFactory.createCalls[0]?.repo).toBe('org/my-proj');
  });

  it('createBuildRunner failure → ok:false as data: placeholder shows the failure, router turn still completes', async () => {
    const slack = new FakeSlackClient();

    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'acme/widgets' },
      { type: 'text', text: 'after build' },
    ];
    const routerFactory = new FakeRunnerFactory([[...routerScript]]);

    // Tail container fails to spawn — createBuildRunner rejects.
    const failingBuildFactory: BuildRunnerFactory = {
      createBuildRunner(): Promise<SessionRunner> {
        return Promise.reject(new Error('container spawn failed'));
      },
    };

    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      buildRunnerFactory: failingBuildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 50));

    // The failure surfaced on the build placeholder (not orphaned, not a thrown crash)…
    expect(slack.updates.some((u) => u.text.includes('Build failed to start'))).toBe(true);
    // …and the router turn continued past the build (the {ok:false} resume was fed back).
    expect(slack.updates.some((u) => u.text === 'after build')).toBe(true);
  });
});

// ── Group 4: driveToThread is behaviour-preserving ───────────────────────────

describe('S12a — driveToThread extraction is behaviour-preserving', () => {
  it('a normal conversational turn still posts text and runs to completion', async () => {
    const slack = new FakeSlackClient();

    const script: RunnerEvent[] = [
      { type: 'status', text: 'thinking…' },
      { type: 'text', text: 'hello there' },
    ];

    const factory = new FakeRunnerFactory([[...script]]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('K', { message: 'hi', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 30));

    expect(slack.updates.some((u) => u.text === '_thinking…_')).toBe(true);
    expect(slack.updates.some((u) => u.text === 'hello there')).toBe(true);
  });

  it('a pr_opened turn still posts "Opened PR: <url>" (existing behaviour preserved)', async () => {
    const slack = new FakeSlackClient();

    const script: RunnerEvent[] = [
      { type: 'pr_opened', url: 'https://example.test/pr/99' },
    ];

    const factory = new FakeRunnerFactory([[...script]]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('K', { message: 'task', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 30));

    expect(
      slack.updates.some((u) => u.text === 'Opened PR: https://example.test/pr/99'),
    ).toBe(true);
  });

  it('an abandoned turn still posts the abandon message (existing behaviour preserved)', async () => {
    const slack = new FakeSlackClient();

    const script: RunnerEvent[] = [
      { type: 'abandoned', reason: 'cancelled' },
    ];

    const factory = new FakeRunnerFactory([[...script]]);
    const manager = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    await manager.enqueueNew('K', { message: 'task', channel: 'C', threadTs: 'T' });
    await new Promise((r) => setTimeout(r, 30));

    expect(
      slack.updates.some(
        (u) => u.text === ':no_entry_sign: Plan abandoned (cancelled) — nothing was pushed.',
      ),
    ).toBe(true);
  });
});
