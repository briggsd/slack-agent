/**
 * Headless Slack REPL — drives the real gateway (or FakeRunnerFactory) without
 * a live Slack connection. Useful for local end-to-end smoke runs.
 *
 * Usage:
 *   npm run build && npm run harness
 *
 * For real Docker smoke: set RUNNER_BACKEND=docker, ANTHROPIC_API_KEY, and have
 * the runner image built. Without those, it defaults to FakeRunnerFactory.
 *
 * This file must NOT import @slack/bolt.
 */
import * as readline from 'node:readline';
import { FakeSlackApp, CapturingSlackClient } from './fake-slack.js';
import { FakeRunnerFactory } from '../runner/fake.js';
import { DockerRunnerFactory } from '../runner/docker.js';
import type { RunnerFactory } from '../runner/types.js';
import { NoopSessionStore } from '../sessions/store.js';
import { buildGateway } from '../app.js';
import { BotAccountBroker } from '../broker/bot-account.js';
import { FakeBroker } from '../broker/fake.js';
import type { GitHost } from '../broker/types.js';
import { DockerGitNodeExecutor } from '../oneshot/docker-git-node.js';
import { parseCheckCmds, parseRepoAllowlist } from '../config.js';
import { FakeGitNodeExecutor } from '../oneshot/fake-git-node.js';
import { DispatchingRunnerFactory } from '../oneshot/dispatching-factory.js';
import { RealCloneService } from '../oneshot/clone-service.js';
import { RealPublishService } from '../oneshot/publish-service.js';
import { RealCheckService } from '../oneshot/check-service.js';

// ─── Minimal config (does not call loadConfig — avoids requiring Slack tokens) ─

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' ? raw : defaultValue;
}

// ─── Wire up ──────────────────────────────────────────────────────────────────

const RUNNER_BACKEND = envString('RUNNER_BACKEND', 'fake');
const IDLE_TIMEOUT_MS = envNumber('IDLE_TIMEOUT_MS', 10 * 60 * 1000);
const PLANNING_IDLE_TIMEOUT_MS = envNumber('PLANNING_IDLE_TIMEOUT_MS', 4 * 60 * 60 * 1000);
const BOT_USER_ID = 'UHARNESS';

let baseFactory: RunnerFactory;
let dispatchingFactory: DispatchingRunnerFactory;

if (RUNNER_BACKEND === 'docker') {
  // Build real broker + git-node executor for docker backend
  const botTokens = new Map<GitHost, string>();
  const githubToken = process.env['GITHUB_BOT_TOKEN'];
  const gitlabToken = process.env['GITLAB_BOT_TOKEN'];
  if (githubToken !== undefined && githubToken !== '') botTokens.set('github', githubToken);
  if (gitlabToken !== undefined && gitlabToken !== '') botTokens.set('gitlab', gitlabToken);
  const broker = new BotAccountBroker(botTokens);
  const lintCmdRaw = process.env['ONESHOT_LINT_CMD'];
  const testCmdRaw = process.env['ONESHOT_TEST_CMD'];
  const checkCmds = parseCheckCmds(process.env['ONESHOT_CHECK_CMDS']);
  const gitNodes = new DockerGitNodeExecutor({
    image: envString('GIT_IMAGE', 'slackbot-runner:latest'),
    ...(lintCmdRaw !== undefined && lintCmdRaw !== '' ? { lintCmd: lintCmdRaw } : {}),
    ...(testCmdRaw !== undefined && testCmdRaw !== '' ? { testCmd: testCmdRaw } : {}),
    ...(checkCmds.size > 0 ? { checkCmds } : {}),
  });
  const cloneService = new RealCloneService(broker, gitNodes, {
    allowedRepos: parseRepoAllowlist(process.env['CLONE_REPO_ALLOWLIST']),
  });
  const publishService = new RealPublishService(broker, gitNodes);
  const checkService = new RealCheckService(gitNodes);
  baseFactory = new DockerRunnerFactory({
    image: envString('RUNNER_IMAGE', 'slackbot-runner:latest'),
    readyTimeoutMs: envNumber('RUNNER_READY_TIMEOUT_MS', 30_000),
    turnTimeoutMs: envNumber('RUNNER_TURN_TIMEOUT_MS', 5 * 60_000),
    killGraceMs: envNumber('RUNNER_KILL_GRACE_MS', 5_000),
    memory: envString('RUNNER_MEMORY', '512m'),
    cpus: envString('RUNNER_CPUS', '1.0'),
    pidsLimit: envNumber('RUNNER_PIDS_LIMIT', 256),
  }, undefined, cloneService, publishService, checkService);
  console.log('[harness] using DockerRunnerFactory');

  dispatchingFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
  console.log(`[harness] one-shot mode: docker (hosts=[${[...botTokens.keys()].join(',')}])`);
} else {
  baseFactory = new FakeRunnerFactory();
  console.log('[harness] using FakeRunnerFactory');

  // Use fakes for offline REPL so `task ...` exercises the one-shot path without Docker
  const broker = new FakeBroker();
  const gitNodes = new FakeGitNodeExecutor();
  dispatchingFactory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);
  console.log('[harness] one-shot mode: fake (offline)');
}

const fakeApp = new FakeSlackApp();
const slack = new CapturingSlackClient({ echo: true });
const store = new NoopSessionStore();

buildGateway({
  app: fakeApp,
  slack,
  factory: dispatchingFactory,
  store,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  planningIdleTimeoutMs: PLANNING_IDLE_TIMEOUT_MS,
  botUserId: BOT_USER_ID,
});

// ─── REPL state ───────────────────────────────────────────────────────────────

let currentChannel = 'C-harness';
let currentThreadTs: string | undefined;
let msgCounter = 0;

function nextTs(): string {
  return `${Date.now()}.${String(++msgCounter).padStart(6, '0')}`;
}

// ─── REPL loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  slack-agent harness — headless Slack REPL           ║');
console.log('║  Commands: /new  start a new thread                  ║');
console.log('║            /quit exit                                 ║');
console.log('║  Anything else is sent as a Slack message.           ║');
console.log('║  First message in a thread → app_mention             ║');
console.log('║  Subsequent messages       → thread reply            ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

function prompt(): void {
  const thread = currentThreadTs ?? '(none)';
  rl.question(`[${currentChannel}/${thread}] > `, (line) => {
    const text = line.trim();

    if (text === '/quit') {
      console.log('[harness] bye');
      rl.close();
      process.exit(0);
    }

    if (text === '/new' || text === '') {
      currentThreadTs = undefined;
      console.log('[harness] new thread started');
      prompt();
      return;
    }

    const ts = nextTs();

    if (currentThreadTs === undefined) {
      // First message in a thread — fire as mention
      const mentionText = `<@${BOT_USER_ID}> ${text}`;
      currentThreadTs = ts;
      void fakeApp
        .fireMention({
          team: 'THARNESS',
          channel: currentChannel,
          threadTs: ts,
          user: 'UOPERATOR',
          text: mentionText,
          ts,
        })
        .then(() => {
          // Give the async drain a moment to start, then re-prompt
          setTimeout(prompt, 100);
        });
    } else {
      // Subsequent messages — fire as thread reply
      void fakeApp
        .fireReply({
          team: 'THARNESS',
          channel: currentChannel,
          threadTs: currentThreadTs,
          user: 'UOPERATOR',
          text,
          ts,
        })
        .then(() => {
          setTimeout(prompt, 100);
        });
    }
  });
}

prompt();
