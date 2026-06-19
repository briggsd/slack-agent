import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
// @slack/bolt is CommonJS — a named import fails at runtime under ESM
import bolt from '@slack/bolt';
const { App } = bolt;
import { loadConfig } from './config.js';
import { SqliteSessionStore } from './sessions/store.js';
import { FakeRunnerFactory } from './runner/fake.js';
import { DockerRunnerFactory } from './runner/docker.js';
import type { RunnerFactory } from './runner/types.js';
import type { SlackClientLike } from './slack/responder.js';
import { buildGateway } from './app.js';
import { BotAccountBroker } from './broker/bot-account.js';
import { FakeBroker } from './broker/fake.js';
import type { CredentialBroker, GitHost } from './broker/types.js';
import { DockerGitNodeExecutor } from './oneshot/docker-git-node.js';
import { FakeGitNodeExecutor } from './oneshot/fake-git-node.js';
import type { GitNodeExecutor } from './oneshot/git-node.js';
import { DispatchingRunnerFactory } from './oneshot/dispatching-factory.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Resolve our bot user ID
  const authResult = await app.client.auth.test({ token: config.SLACK_BOT_TOKEN });
  const botUserId = authResult.user_id;
  if (typeof botUserId !== 'string') {
    throw new Error('Could not determine bot user ID from auth.test');
  }

  // Minimal Slack client wrapper
  const slack: SlackClientLike = {
    async postMessage(params) {
      const result = await app.client.chat.postMessage({
        channel: params.channel,
        thread_ts: params.thread_ts,
        text: params.text,
      });
      const ts = result.ts;
      if (typeof ts !== 'string') {
        throw new Error('chat.postMessage did not return a ts');
      }
      return { ts };
    },
    async update(params) {
      await app.client.chat.update({
        channel: params.channel,
        ts: params.ts,
        text: params.text,
      });
    },
    async uploadFile(params) {
      // Verified against node_modules/@slack/web-api/dist/methods.d.ts:
      // FilesUploadV2Arguments extends FileUploadV2 (extends FileUpload) with
      // channel_id, thread_ts, file (Buffer), filename
      await app.client.files.uploadV2({
        channel_id: params.channel,
        thread_ts: params.thread_ts,
        filename: params.filename,
        file: params.data,
      });
    },
  };

  // Ensure the parent directory for the DB exists before opening it.
  await mkdir(dirname(config.SESSION_DB_PATH), { recursive: true });
  const store = new SqliteSessionStore(config.SESSION_DB_PATH);
  console.log(`[gateway] session store opened at ${config.SESSION_DB_PATH}`);

  const closeStore = (): void => {
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', closeStore);
  process.on('SIGINT', closeStore);

  // Base agent factory + the one-shot dependencies are chosen together by backend,
  // so a fake-backend deployment never reaches for real Docker or real tokens on a
  // `task` mention. (Mirrors src/harness/cli.ts.)
  let baseFactory: RunnerFactory;
  let broker: CredentialBroker;
  let gitNodes: GitNodeExecutor;
  const oc = config.oneshot;
  if (config.RUNNER_BACKEND === 'docker') {
    const dc = config.docker;
    baseFactory = new DockerRunnerFactory({
      image: dc.RUNNER_IMAGE,
      readyTimeoutMs: dc.RUNNER_READY_TIMEOUT_MS,
      turnTimeoutMs: dc.RUNNER_TURN_TIMEOUT_MS,
      killGraceMs: dc.RUNNER_KILL_GRACE_MS,
      memory: dc.RUNNER_MEMORY,
      cpus: dc.RUNNER_CPUS,
      pidsLimit: dc.RUNNER_PIDS_LIMIT,
    });
    console.log(`[gateway] using DockerRunnerFactory (image=${dc.RUNNER_IMAGE})`);

    const botTokens = new Map<GitHost, string>();
    if (oc.githubToken !== undefined) botTokens.set('github', oc.githubToken);
    if (oc.gitlabToken !== undefined) botTokens.set('gitlab', oc.gitlabToken);
    broker = new BotAccountBroker(botTokens);
    gitNodes = new DockerGitNodeExecutor({
      image: oc.GIT_IMAGE,
      ...(oc.lintCommand !== undefined ? { lintCmd: oc.lintCommand } : {}),
      ...(oc.testCommand !== undefined ? { testCmd: oc.testCommand } : {}),
      ...(oc.checkCmds.size > 0 ? { checkCmds: oc.checkCmds } : {}),
    });
    console.log(
      `[gateway] one-shot enabled (git image=${oc.GIT_IMAGE}, hosts=[${[...botTokens.keys()].join(',')}])`,
    );
  } else {
    baseFactory = new FakeRunnerFactory();
    console.log('[gateway] using FakeRunnerFactory');

    broker = new FakeBroker();
    gitNodes = new FakeGitNodeExecutor();
    console.log('[gateway] one-shot enabled (fake — no real git operations)');
  }

  const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

  buildGateway({
    // Cast to BoltAppLike — buildGateway / registerSlackHandlers only needs the minimal .event() shape
    app: app as Parameters<typeof buildGateway>[0]['app'],
    slack,
    factory,
    store,
    idleTimeoutMs: config.IDLE_TIMEOUT_MS,
    gateTimeoutMs: config.GATE_TIMEOUT_MS,
    botUserId,
  });

  await app.start();
  console.log(`[gateway] Slack bot started (botUserId=${botUserId})`);
}

main().catch((err: unknown) => {
  console.error('[gateway] fatal error:', err);
  process.exit(1);
});
