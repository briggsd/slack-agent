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
import { SqliteSessionStore } from '../src/sessions/store.js';
import type { BuildRunnerFactory, ExecInput } from '../src/runner/types.js';
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
  it('completes as a local candidate with branch+fix loop only and no credential lease', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://github.com/acme/widgets/pull/1');
    const baseFactory = new FakeRunnerFactory([
      // implement turn (the only agentic turn in build-tail)
      [{ type: 'text', text: 'impl done' }],
    ]);

    const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
    const runner = await factory.createBuildRunner(TEST_SESSION_KEY, 'acme/widgets');

    const events = await drain(runner.send(''));

    const statusTexts = events
      .filter((e): e is { type: 'status'; text: string } => e.type === 'status')
      .map((e) => e.text);
    expect(statusTexts).toContain('creating branch…');
    expect(statusTexts).toContain('implementing…');
    expect(statusTexts).toContain('linting…');
    expect(statusTexts).toContain('testing…');
    expect(statusTexts).not.toContain('pushing branch…');
    expect(statusTexts).not.toContain('opening pull request…');

    // No errors
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'pr_opened')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);

    // No clone was run (build tail skips clone/research/plan)
    expect(gitNodes.clones).toHaveLength(0);

    // Branch was created on workdir derived from repo slug
    const expectedBranch = `slackbot/oneshot-${sanitizeKey(TEST_SESSION_KEY)}`;
    expect(gitNodes.branches).toHaveLength(1);
    expect(gitNodes.branches[0]?.branch).toBe(expectedBranch);
    expect(gitNodes.branches[0]?.workdir).toBe('/workspace/acme-widgets');
    expect(gitNodes.branches[0]?.volume).toBe(volumeNameFor(TEST_SESSION_KEY));

    // Checks still ran on the local candidate
    expect(gitNodes.checks).toHaveLength(2);
    expect(gitNodes.checks[0]?.kind).toBe('lint');
    expect(gitNodes.checks[1]?.kind).toBe('test');
    expect(gitNodes.checks[0]?.repo).toBe('acme/widgets');
    expect(gitNodes.checks[1]?.repo).toBe('acme/widgets');

    // No push or PR open happens in the local-only build tail
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);

    // Broker is untouched for the local-only build tail
    expect(broker.leases).toHaveLength(0);
    expect(broker.revokes).toHaveLength(0);

    // Inner runner was requested with nameSuffix:'build'
    expect(baseFactory.suffixes).toHaveLength(1);
    expect(baseFactory.suffixes[0]).toBe('build');
  });

  it('emits an error instead of reporting candidate-ready when checks still fail after retries', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://github.com/acme/widgets/pull/1');
    gitNodes.setCheckResult('lint', {
      exitCode: 1,
      output: 'Error: socket hang up',
      skipped: false,
    });
    const baseFactory = new FakeRunnerFactory([
      [{ type: 'text', text: 'impl cycle 1 done' }],
      [{ type: 'text', text: 'impl cycle 2 done' }],
    ]);

    const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
    const runner = await factory.createBuildRunner(TEST_SESSION_KEY, 'acme/widgets');

    const events = await drain(runner.send(''));

    expect(
      events.some((e) => e.type === 'error' && e.message === 'build checks failed after retries'),
    ).toBe(true);
    expect(events.filter((e) => e.type === 'pr_opened')).toHaveLength(0);
    expect(gitNodes.checks).toHaveLength(4);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
    expect(broker.leases).toHaveLength(0);
    expect(broker.revokes).toHaveLength(0);
    expect(baseFactory.suffixes).toEqual(['build']);
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
    public execCreateCalls: Array<{ sessionKey: string; input: ExecInput }> = [];
    private tailScript: RunnerEvent[][];
    private execScript: RunnerEvent[][];

    constructor(tailScript: RunnerEvent[][] = [], execScript: RunnerEvent[][] = []) {
      this.tailScript = tailScript;
      this.execScript = execScript;
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

    async createExecRunner(sessionKey: string, input: ExecInput): Promise<SessionRunner> {
      this.execCreateCalls.push({ sessionKey, input });
      const runner = new FakeRunner(sessionKey, this.execScript);
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

  it('tail completes locally → no PR update is posted and the router turn resumes successfully', async () => {
    const slack = new FakeSlackClient();

    // Router runner yields a run_build event then a text completion
    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'acme/widgets' },
      { type: 'text', text: 'router resumed' },
    ];

    // Tail runner completes with local-only output
    const tailScript: RunnerEvent[] = [
      { type: 'status', text: 'testing…' },
      { type: 'text', text: 'candidate ready locally' },
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

    expect(slack.updates.some((u) => u.text === 'candidate ready locally')).toBe(true);
    expect(slack.updates.some((u) => u.text === 'router resumed')).toBe(true);
    expect(slack.updates.some((u) => u.text.includes('Opened PR:'))).toBe(false);

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
      { type: 'error', message: 'impl failed', reason: 'runner_error' },
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

    const tailScript: RunnerEvent[] = [{ type: 'text', text: 'done locally' }];

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
      createExecRunner(): Promise<SessionRunner> {
        return Promise.reject(new Error('should not run exec'));
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

  it('over-budget at run_build boundary refuses before spawning the build tail and resumes the router', async () => {
    const slack = new FakeSlackClient();
    const store = new SqliteSessionStore(':memory:');
    let releaseRouter!: () => void;
    const routerReady = new Promise<void>((resolve) => {
      releaseRouter = resolve;
    });

    const routerScript = async (): Promise<RunnerEvent[]> => {
      await routerReady;
      return [
        { type: 'run_build', repo: 'acme/widgets' },
        { type: 'text', text: 'router resumed' },
      ];
    };
    const routerFactory = new FakeRunnerFactory([routerScript]);
    const buildFactory = new FakeBuildFactory([[{ type: 'text', text: 'should not run' }]]);
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory: buildFactory,
      spendCaps: { perTaskMicroUsd: 5_000_000, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
    });

    try {
      const enqueue = manager.enqueueNew(TEST_SESSION_KEY, {
        message: 'go',
        channel: 'C',
        threadTs: 'T',
        teamId: 'TEAM',
        userId: 'U1',
      });
      await new Promise((r) => setTimeout(r, 20));

      store.recordAudit({
        session_key: TEST_SESSION_KEY,
        team_id: 'TEAM',
        user_id: 'U1',
        profile_id: 'conversational',
        ts: Date.now(),
        kind: 'cost',
        tool: null,
        summary: null,
        reasoning: null,
        result: null,
        cost_tokens: null,
        cost_micro_usd: 5_000_000,
        durations_ms: null,
      });

      releaseRouter();
      await enqueue;
      await new Promise((r) => setTimeout(r, 30));

      expect(buildFactory.createCalls).toHaveLength(0);
      expect(slack.posts.filter((p) => p.text === '_thinking…_')).toHaveLength(1);
      expect(slack.posts.some((p) => p.text.includes('reached its budget'))).toBe(true);
      expect(slack.updates.some((u) => u.text === 'router resumed')).toBe(true);

      const capAudits = store
        .getAuditEvents(TEST_SESSION_KEY)
        .filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
      expect(capAudits).toHaveLength(1);
      expect(capAudits[0]?.result).toBe('abandoned:task');
      expect(capAudits[0]?.user_id).toBe('U1');
    } finally {
      store.close();
    }
  });

  it('build-tail usage is billed to the same session and requestor budget', async () => {
    const slack = new FakeSlackClient();
    const store = new SqliteSessionStore(':memory:');
    const tailCostMicroUsd = 2_500_000;
    const routerScript: RunnerEvent[] = [
      { type: 'run_build', repo: 'acme/widgets' },
      { type: 'text', text: 'router resumed' },
    ];
    const tailScript: RunnerEvent[] = [
      {
        type: 'usage',
        costMicroUsd: tailCostMicroUsd,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      },
      { type: 'text', text: 'candidate ready locally' },
    ];
    const routerFactory = new FakeRunnerFactory([[...routerScript], [{ type: 'text', text: 'should not run' }]]);
    const buildFactory = new FakeBuildFactory([[...tailScript]]);
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory: buildFactory,
      spendCaps: { perTaskMicroUsd: tailCostMicroUsd, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
    });

    try {
      await manager.enqueueNew(TEST_SESSION_KEY, {
        message: 'go',
        channel: 'C',
        threadTs: 'T',
        teamId: 'TEAM',
        userId: 'U1',
      });
      await new Promise((r) => setTimeout(r, 50));

      const costAudits = store
        .getAuditEvents(TEST_SESSION_KEY)
        .filter((a) => a.kind === 'cost');
      expect(costAudits).toHaveLength(1);
      expect(costAudits[0]?.session_key).toBe(TEST_SESSION_KEY);
      expect(costAudits[0]?.team_id).toBe('TEAM');
      expect(costAudits[0]?.user_id).toBe('U1');
      expect(costAudits[0]?.cost_micro_usd).toBe(tailCostMicroUsd);
      expect(costAudits[0]?.cost_tokens).toBe(100);
      expect(store.sumCostByTask(TEST_SESSION_KEY)).toBe(tailCostMicroUsd);

      const accepted = await manager.enqueueExisting(TEST_SESSION_KEY, {
        message: 'again',
        channel: 'C',
        threadTs: 'T',
        userId: 'U1',
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(accepted).toBe(true);
      expect(routerFactory.runners[0]?.sends).toEqual(['go']);
      expect(slack.posts.some((p) => p.text.includes('reached its budget'))).toBe(true);
      const capAudits = store
        .getAuditEvents(TEST_SESSION_KEY)
        .filter((a) => a.kind === 'correction' && a.tool === 'spend-cap');
      expect(capAudits).toHaveLength(1);
      expect(capAudits[0]?.result).toBe('rejected:task');
    } finally {
      store.close();
    }
  });

  it('run_exec without a recorded requestor refuses before creating an exec runner', async () => {
    const slack = new FakeSlackClient();
    const routerScript: RunnerEvent[] = [
      { type: 'run_exec', host: 'github', repo: 'acme/widgets', instruction: 'ship it' },
      { type: 'text', text: 'router resumed' },
    ];
    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory();
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
      teamId: 'TEAM',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(buildFactory.execCreateCalls).toHaveLength(0);
    expect(slack.updates.some((u) => u.text === 'router resumed')).toBe(true);
  });

  it('run_exec without requestor opt-in refuses before creating an exec runner', async () => {
    const slack = new FakeSlackClient();
    const store = new SqliteSessionStore(':memory:');
    const routerScript: RunnerEvent[] = [
      { type: 'run_exec', host: 'github', repo: 'acme/widgets', instruction: 'ship it' },
      { type: 'text', text: 'router resumed' },
    ];
    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory();
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory: buildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(buildFactory.execCreateCalls).toHaveLength(0);
    expect(slack.updates.some((u) => u.text === 'router resumed')).toBe(true);
    store.close();
  });

  it('run_exec with recorded requestor opt-in runs repo-oneshot and resumes the router', async () => {
    const slack = new FakeSlackClient();
    const store = new SqliteSessionStore(':memory:');
    store.recordExecOptIn('TEAM', 'U1', Date.now());
    const routerScript: RunnerEvent[] = [
      { type: 'run_exec', host: 'github', repo: 'acme/widgets', instruction: 'ship it' },
      { type: 'text', text: 'router resumed' },
    ];
    const execScript: RunnerEvent[] = [
      {
        type: 'pr_opened',
        url: 'https://github.com/acme/widgets/pull/42',
        repo: 'acme/widgets',
        number: 42,
        headSha: 'exec-head-sha',
      },
      { type: 'text', text: 'exec done' },
    ];
    const routerFactory = new FakeRunnerFactory([[...routerScript]]);
    const buildFactory = new FakeBuildFactory([], [[...execScript]]);
    const manager = new SessionManager({
      idleTimeoutMs: 60_000,
      factory: routerFactory,
      slack,
      store,
      buildRunnerFactory: buildFactory,
    });

    await manager.enqueueNew(TEST_SESSION_KEY, {
      message: 'go',
      channel: 'C',
      threadTs: 'T',
      teamId: 'TEAM',
      userId: 'U1',
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(buildFactory.execCreateCalls).toEqual([
      {
        sessionKey: TEST_SESSION_KEY,
        input: { host: 'github', repo: 'acme/widgets', instruction: 'ship it' },
      },
    ]);
    expect(buildFactory.disposedRunners).toHaveLength(1);
    expect(slack.updates.some((u) => u.text === 'Opened PR: https://github.com/acme/widgets/pull/42')).toBe(true);
    expect(slack.updates.some((u) => u.text === 'router resumed')).toBe(true);
    store.close();
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
      {
        type: 'pr_opened',
        url: 'https://example.test/pr/99',
        repo: 'acme/widgets',
        number: 99,
        headSha: 'drive-head-sha',
      },
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
