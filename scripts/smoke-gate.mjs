/**
 * Throwaway S04 smoke driver for the M6 plan-approval gate (#22).
 *
 * Drives the REAL gateway → real Docker container (Agent SDK) → real DockerGitNodeExecutor
 * through the fake-Slack harness. Fires a `task` mention (supervised), waits for the run to
 * park at the plan gate, then replies in-thread to exercise a terminal outcome.
 *
 * Two flows, each its own thread/container:
 *   1. approve → research → plan → [gate] → approve → implement → push → PR
 *   2. cancel  → research → plan → [gate] → cancel  → abandoned (no branch/push/PR)
 *
 * Prereqs: Docker running, slackbot-runner:latest built, ANTHROPIC_API_KEY in env,
 * GITHUB_TEST_REPO + GITHUB_TEST_TOKEN in env. NOT part of CI.
 */
import { execFileSync } from 'node:child_process';
import { FakeSlackApp, CapturingSlackClient } from '../dist/harness/fake-slack.js';
import { DockerRunnerFactory, volumeNameFor } from '../dist/runner/docker.js';
import { NoopSessionStore } from '../dist/sessions/store.js';
import { buildGateway } from '../dist/app.js';
import { BotAccountBroker } from '../dist/broker/bot-account.js';
import { DockerGitNodeExecutor } from '../dist/oneshot/docker-git-node.js';
import { DispatchingRunnerFactory } from '../dist/oneshot/dispatching-factory.js';

const REPO = process.env.GITHUB_TEST_REPO;
const TOKEN = process.env.GITHUB_TEST_TOKEN;
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
if (!REPO || !TOKEN) throw new Error('GITHUB_TEST_REPO / GITHUB_TEST_TOKEN not set');

const broker = new BotAccountBroker(new Map([['github', TOKEN]]));
const baseFactory = new DockerRunnerFactory({
  image: 'slackbot-runner:latest',
  readyTimeoutMs: 30_000,
  turnTimeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
});
const gitNodes = new DockerGitNodeExecutor({ image: 'slackbot-runner:latest' });
const factory = new DispatchingRunnerFactory(baseFactory, broker, gitNodes);

const app = new FakeSlackApp();
const slack = new CapturingSlackClient({ echo: false });
const { sessions } = buildGateway({
  app,
  slack,
  factory,
  store: new NoopSessionStore(),
  idleTimeoutMs: 10 * 60_000,
  gateTimeoutMs: 5 * 60_000,
  botUserId: 'UHARNESS',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(channel, pred, timeoutMs, label) {
  const start = Date.now();
  let lastSeen = '';
  while (Date.now() - start < timeoutMs) {
    const mine = slack.updates.filter((u) => u.channel === channel);
    const cur = mine.at(-1)?.text ?? '';
    if (cur !== lastSeen) {
      console.log(`    · ${cur.replace(/\s+/g, ' ').slice(0, 110)}`);
      lastSeen = cur;
    }
    if (mine.some((u) => pred(u.text))) return mine.find((u) => pred(u.text)).text;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const keys = [];

async function flow({ name, team, channel, instruction, reply, expectSubstr }) {
  const ts = `${team}-ts`;
  const key = `${team}:${channel}:${ts}`;
  keys.push(key);
  console.log(`\n=== FLOW: ${name} (repo=${REPO}) ===`);
  console.log(`>>> firing: task github:${REPO} ${instruction}`);
  await app.fireMention({
    team,
    channel,
    threadTs: ts,
    user: 'USMOKE',
    text: `<@UHARNESS> task github:${REPO} ${instruction}`,
    ts,
  });

  console.log('>>> waiting to park at the plan gate…');
  await waitFor(channel, (t) => t.includes('Reply `approve`'), 4 * 60_000, 'gate prompt');
  console.log(`>>> PARKED. replying: "${reply}"`);
  await app.fireReply({ team, channel, threadTs: ts, user: 'USMOKE', text: reply, ts: `${ts}-r` });

  const final = await waitFor(channel, (t) => t.includes(expectSubstr), 4 * 60_000, expectSubstr);
  console.log(`>>> OUTCOME (${name}): ${final.replace(/\s+/g, ' ').slice(0, 160)}`);
  return final;
}

try {
  await flow({
    name: 'approve',
    team: 'TAPPROVE',
    channel: 'CAPP',
    instruction: 'add a short line to SMOKE.md noting an approved gate run; keep it tiny',
    reply: 'approve',
    expectSubstr: 'Opened PR:',
  });

  await flow({
    name: 'cancel',
    team: 'TCANCEL',
    channel: 'CCAN',
    instruction: 'add a different short line to SMOKE.md; keep it tiny',
    reply: 'cancel',
    expectSubstr: 'Plan abandoned',
  });

  console.log('\n=== SMOKE PASSED (both flows reached their terminal outcome) ===');
} catch (err) {
  console.error('\n=== SMOKE FAILED ===');
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  console.log('\n>>> disposing sessions…');
  await sessions.disposeAll();
  for (const key of keys) {
    const vol = volumeNameFor(key);
    try {
      execFileSync('docker', ['volume', 'rm', vol], { stdio: 'ignore' });
      console.log(`>>> removed volume ${vol}`);
    } catch {
      // volume may not exist or still be in use briefly — best effort
    }
  }
  console.log('>>> done. Close any smoke PR on', REPO, 'manually (gh pr close … --delete-branch).');
}
