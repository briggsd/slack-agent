/**
 * Throwaway S10b commit-gate smoke. Drives the REAL gateway → real Docker container
 * (Agent SDK) via the fake-Slack harness. Exercises the full round-trip that the offline
 * gate can't: the model calls the submit_spec tool → the runner emits request_approval →
 * the gateway parks and posts the spec → the requestor replies "approve" → the gateway sends
 * approval_verdict → the container's parked tool unblocks → the turn finishes.
 *
 * Proves S10a (gateway park + requestor gate + verdict) AND S10b (container tool + stdin demux)
 * end to end. A post-approval final reply is the proof the verdict reached the container: if it
 * had not, the parked tool would hang and the turn would time out with no reply.
 *
 * Prereqs: Docker running, slackbot-runner:latest built (with S10b), ANTHROPIC_API_KEY in env,
 * root dist/ built (npm run build). NOT CI.
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

const dbDir = mkdtempSync(join(tmpdir(), 'sa-gate-smoke-'));
const store = new SqliteSessionStore(join(dbDir, 'sessions.db'));
const factory = new DockerRunnerFactory({
  image: 'slackbot-runner:latest',
  readyTimeoutMs: 30_000,
  turnTimeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  memory: '512m',
  cpus: '1.0',
  pidsLimit: 256,
});

const app = new FakeSlackApp();
const slack = new CapturingSlackClient({ echo: false });
const { sessions } = buildGateway({
  app,
  slack,
  factory,
  store,
  idleTimeoutMs: 10 * 60_000,
  gateTimeoutMs: 5 * 60_000,
  botUserId: 'UHARNESS',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const team = 'TSMOKE';
const channel = 'CSMOKE';
const ts = 'gate-smoke-ts';
const user = 'USMOKE';
const key = `${team}:${channel}:${ts}`;

/** The marker the gateway's awaitApproval appends when it parks at a gate. */
const GATE_MARKER = 'No reply within';

async function waitForUpdate(pred, timeoutMs, label) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const mine = slack.updates.filter((u) => u.channel === channel);
    const cur = mine.at(-1)?.text ?? '';
    if (cur !== last) {
      console.log(`    · ${cur.replace(/\s+/g, ' ').slice(0, 140)}`);
      last = cur;
    }
    const hit = mine.find((u) => pred(u.text));
    if (hit) return hit.text;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

try {
  console.log('=== Turn 1: mention that should make the agent call submit_spec ===');
  await app.fireMention({
    team,
    channel,
    threadTs: ts,
    user,
    ts,
    text:
      '<@UHARNESS> Use your submit_spec tool to propose this plan for my approval: ' +
      '"Add a hello() function that returns the string hello." Submit it and wait for my ' +
      'decision before doing anything else.',
  });

  // The gateway parks at the commit gate and posts the spec + the timeout marker.
  const gateText = await waitForUpdate((t) => t.includes(GATE_MARKER), 4 * 60_000, 'commit gate posted');
  console.log(`\n>>> GATE POSTED (request_approval round-tripped). Replying "approve"…`);

  console.log('\n=== Turn 2: requestor approves ===');
  await app.fireReply({
    team,
    channel,
    threadTs: ts,
    user,
    ts: `${ts}-approve`,
    text: 'approve',
  });

  // After approval the verdict must reach the container's parked tool and the turn must
  // finish with a real (non-gate, non-placeholder) reply.
  const finalText = await waitForUpdate(
    (t) => t && !t.includes(GATE_MARKER) && !/^_.*_$/.test(t.trim()) && !t.startsWith(':x:'),
    4 * 60_000,
    'post-approval final reply',
  );
  console.log(`\n>>> POST-APPROVAL REPLY: "${finalText.replace(/\s+/g, ' ').slice(0, 120)}"`);

  const gateAudit = store.getAuditEvents(key).filter((a) => a.tool === 'plan-gate');
  console.log(`>>> gate audit rows: ${gateAudit.map((a) => a.result).join(', ') || '(none)'}`);

  const ok =
    gateText.includes(GATE_MARKER) &&
    finalText.length > 0 &&
    !finalText.startsWith(':x:') &&
    !finalText.includes(GATE_MARKER);
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
