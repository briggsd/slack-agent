import 'dotenv/config';
// @slack/bolt is CommonJS — a named import fails at runtime under ESM
import bolt from '@slack/bolt';
const { App } = bolt;
import { loadConfig } from './config.js';
import { SessionManager } from './sessions/manager.js';
import { FakeRunnerFactory } from './runner/fake.js';
import { DockerRunnerFactory } from './runner/docker.js';
import type { RunnerFactory } from './runner/types.js';
import { registerSlackHandlers } from './slack/listener.js';
import type { SlackClientLike } from './slack/responder.js';

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

  let factory: RunnerFactory;
  if (config.RUNNER_BACKEND === 'docker') {
    const dc = config.docker;
    factory = new DockerRunnerFactory({
      image: dc.RUNNER_IMAGE,
      readyTimeoutMs: dc.RUNNER_READY_TIMEOUT_MS,
      turnTimeoutMs: dc.RUNNER_TURN_TIMEOUT_MS,
      killGraceMs: dc.RUNNER_KILL_GRACE_MS,
      memory: dc.RUNNER_MEMORY,
      cpus: dc.RUNNER_CPUS,
      pidsLimit: dc.RUNNER_PIDS_LIMIT,
    });
    console.log(`[gateway] using DockerRunnerFactory (image=${dc.RUNNER_IMAGE})`);
  } else {
    factory = new FakeRunnerFactory();
    console.log('[gateway] using FakeRunnerFactory');
  }

  const sessions = new SessionManager({
    idleTimeoutMs: config.IDLE_TIMEOUT_MS,
    factory,
    slack,
  });

  // Cast to BoltAppLike — registerSlackHandlers only needs the minimal .event() shape
  registerSlackHandlers(app as Parameters<typeof registerSlackHandlers>[0], { sessions, slack, botUserId });

  await app.start();
  console.log(`[gateway] Slack bot started (botUserId=${botUserId})`);
}

main().catch((err: unknown) => {
  console.error('[gateway] fatal error:', err);
  process.exit(1);
});
