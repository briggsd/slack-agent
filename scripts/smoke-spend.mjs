/**
 * Throwaway B1 spend-caps smoke. Drives the REAL gateway → real Docker container
 * (Agent SDK) via the fake-Slack harness, with a real SqliteSessionStore (temp file)
 * and a tiny per-task cap. Two turns in one thread:
 *   1. a cheap conversational mention → measures the real per-turn cost in the ledger;
 *   2. a reply in the same thread → admission must reject on the per-task cap.
 *
 * Prereqs: Docker running, slackbot-runner:latest built, ANTHROPIC_API_KEY in env. NOT CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeSlackApp, CapturingSlackClient } from '../dist/harness/fake-slack.js';
import { DockerRunnerFactory, volumeNameFor } from '../dist/runner/docker.js';
import { SqliteSessionStore } from '../dist/sessions/store.js';
import { buildGateway } from '../dist/app.js';

if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

const dbDir = mkdtempSync(join(tmpdir(), 'sa-smoke-'));
const store = new SqliteSessionStore(join(dbDir, 'sessions.db'));
const factory = new DockerRunnerFactory({
  image: 'slackbot-runner:latest',
  readyTimeoutMs: 30_000,
  turnTimeoutMs: 5 * 60_000,
  absoluteTurnTimeoutMs: 30 * 60_000,
  killGraceMs: 5_000,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
});

const app = new FakeSlackApp();
const slack = new CapturingSlackClient({ echo: false });
// Tiny per-task cap (1 micro-USD) so the SECOND turn trips once turn 1's real cost lands.
const { sessions } = buildGateway({
  app,
  slack,
  factory,
  store,
  idleTimeoutMs: 10 * 60_000,
  botUserId: 'UHARNESS',
  spendCaps: { perTaskMicroUsd: 1, perUser24hMicroUsd: 0, perGlobal24hMicroUsd: 0 },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const team = 'TSMOKE';
const channel = 'CSMOKE';
const ts = 'smoke-ts';
const key = `${team}:${channel}:${ts}`;

async function waitForUpdate(pred, timeoutMs, label) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const mine = slack.updates.filter((u) => u.channel === channel);
    const cur = mine.at(-1)?.text ?? '';
    if (cur !== last) {
      console.log(`    · ${cur.replace(/\s+/g, ' ').slice(0, 120)}`);
      last = cur;
    }
    const hit = mine.find((u) => pred(u.text));
    if (hit) return hit.text;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

try {
  console.log('=== Turn 1: conversational mention (real container) ===');
  await app.fireMention({
    team,
    channel,
    threadTs: ts,
    user: 'USMOKE',
    text: '<@UHARNESS> Reply with exactly the word: hello',
    ts,
  });
  const reply1 = await waitForUpdate(
    (t) => t && !/^_.*_$/.test(t.trim()) && !t.startsWith(':x:'),
    4 * 60_000,
    'agent reply',
  );
  console.log(`>>> agent replied: "${reply1.replace(/\s+/g, ' ').slice(0, 80)}"`);

  await sleep(500);
  const costMicro = store.sumCostByTask(key);
  const costRows = store.getAuditEvents(key).filter((a) => a.kind === 'cost');
  console.log(
    `\n>>> MEASURED per-task cost: ${costMicro} micro-USD = $${(costMicro / 1e6).toFixed(6)}  (${costRows.length} cost row(s))`,
  );
  if (costRows[0]) console.log(`    total tokens recorded: ${costRows[0].cost_tokens}`);

  console.log('\n=== Turn 2: reply in same thread (should hit the per-task cap) ===');
  await app.fireReply({
    team,
    channel,
    threadTs: ts,
    user: 'USMOKE',
    text: 'and again please',
    ts: `${ts}-r`,
  });
  await sleep(1500);
  const capPost = slack.posts.find((p) => p.text.includes('reached its budget'));
  console.log(`>>> cap message: ${capPost ? `"${capPost.text}"` : 'NOT FOUND'}`);
  const capAudit = store
    .getAuditEvents(key)
    .find((a) => a.kind === 'correction' && a.tool === 'spend-cap');
  console.log(`>>> cap audit row: ${capAudit ? `result=${capAudit.result}` : 'NOT FOUND'}`);

  const ok = costMicro >= 1 && capPost !== undefined && capAudit?.result === 'rejected:task';
  console.log(`\n=== SMOKE ${ok ? 'PASSED' : 'FAILED'} ===`);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error('\n=== SMOKE ERROR ===');
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  console.log('\n>>> disposing…');
  await sessions.disposeAll();
  store.close();
  try {
    execFileSync('docker', ['volume', 'rm', volumeNameFor(key)], { stdio: 'ignore' });
    console.log(`>>> removed volume ${volumeNameFor(key)}`);
  } catch {
    // best effort
  }
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  console.log('>>> done.');
}
