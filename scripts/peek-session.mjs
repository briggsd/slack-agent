/**
 * peek-session — operator-only debugging helper (issue bcbd77).
 *
 * Prints a readable tool-call timeline for one Slack-agent session by reading the
 * Claude Agent SDK transcript that lives ON THE SESSION VOLUME (HOME=/workspace
 * inside the container, so the transcript is /workspace/.claude/projects/-workspace/
 * <uuid>.jsonl and survives container reap). The gateway logs deliberately cannot
 * show agent commands — the "never log message contents/tokens" invariant — so this
 * is the supported path to see what an agent actually ran when debugging a stuck or
 * timed-out turn.
 *
 *   node scripts/peek-session.mjs <volume-name | session-key> [--tail N] [--full]
 *
 *   <volume-name>   e.g. slackbot-ws-t0auzmxu282-c0bbx7b0j9y-1782617150-666129
 *   <session-key>   e.g. T0AUZMXU282:C0BBX7B0J9Y:1782617150.666129  (auto-sanitized)
 *   --tail N        show only the last N events (default 40; 0 = all)
 *   --full          do not truncate input/result text
 *
 * READ-ONLY. Reads the volume via a throwaway `docker run` against the runner image,
 * so it works even after the session's container has exited. This surfaces user
 * conversation contents to the operator — keep it operator-only / local; it is NOT
 * wired into the gateway and must never be.
 */
import { execFileSync } from 'node:child_process';

const IMAGE = process.env.RUNNER_IMAGE ?? 'slackbot-runner:latest';

function usage(msg) {
  if (msg) process.stderr.write(`peek-session: ${msg}\n`);
  process.stderr.write(
    'usage: node scripts/peek-session.mjs <volume-name|session-key> [--tail N] [--full]\n',
  );
  process.exit(msg ? 2 : 0);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) usage();

let target;
let tail = 40;
let full = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--full') full = true;
  else if (a === '--tail') {
    tail = Number(args[++i]);
    if (!Number.isFinite(tail) || tail < 0) usage('--tail needs a non-negative number');
  } else if (target === undefined) target = a;
  else usage(`unexpected argument: ${a}`);
}
if (target === undefined) usage('missing volume name or session key');

// A session key (TEAM:CHANNEL:TS) sanitizes to the volume suffix: lowercase, and
// every char outside [a-z0-9] collapsed to '-' (matching the gateway's volume naming).
function toVolume(t) {
  if (t.startsWith('slackbot-ws-')) return t;
  const suffix = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `slackbot-ws-${suffix}`;
}
const volume = toVolume(target);

// Pre-check existence so a typo doesn't silently auto-create an empty junk volume
// (which `docker run -v` would do).
try {
  execFileSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' });
} catch {
  usage(`volume "${volume}" not found (list with: docker volume ls | grep slackbot-ws)`);
}

let raw;
try {
  raw = execFileSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${volume}:/workspace:ro`,
      '--entrypoint', 'sh',
      IMAGE,
      // `|| true` so a missing transcript yields empty stdout (handled below) rather
      // than a non-zero exit from cat hitting an unmatched glob.
      '-c', 'cat /workspace/.claude/projects/*/*.jsonl 2>/dev/null || true',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
} catch (e) {
  usage(`could not read volume "${volume}" (is the runner image "${IMAGE}" built?)\n  ${String(e.message ?? e)}`);
}

if (!raw || raw.trim() === '') {
  process.stderr.write(`peek-session: no SDK transcript found on volume "${volume}"\n`);
  process.exit(1);
}

const clip = (s, n) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return full || flat.length <= n ? flat : `${flat.slice(0, n)}…`;
};

const events = [];
for (const line of raw.split('\n')) {
  if (line.trim() === '') continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  // Full ISO timestamp is the chronological sort key (ISO sorts lexically); the
  // HH:MM:SS slice is just for display. A volume can hold more than one transcript
  // file (e.g. after a resume), and `cat *.jsonl` concatenates them in glob order —
  // sort by `key` below so the timeline stays chronological across files.
  const key = typeof o.timestamp === 'string' ? o.timestamp : '';
  const ts = key !== '' ? key.slice(11, 19) : '--:--:--';
  const content = o.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b?.type === 'tool_use') {
      const detail =
        b.name === 'Bash' ? (b.input?.command ?? '')
        : JSON.stringify(b.input ?? {});
      events.push({ key, ts, kind: `TOOL ${b.name}`, detail: clip(detail, full ? 1e9 : 160) });
    } else if (b?.type === 'tool_result') {
      const txt = Array.isArray(b.content)
        ? b.content.map((x) => x.text ?? '').join(' ')
        : String(b.content ?? '');
      events.push({ key, ts, kind: '  └ result', detail: clip(txt, full ? 1e9 : 90) });
    }
  }
}

if (events.length === 0) {
  process.stderr.write(`peek-session: transcript on "${volume}" had no tool calls\n`);
  process.exit(1);
}

// Stable sort by ISO timestamp so multiple concatenated transcript files interleave
// chronologically (Node's sort is stable, so timestamp-less events keep their order).
events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const shown = tail === 0 ? events : events.slice(-tail);
process.stdout.write(`session volume: ${volume}\n`);
process.stdout.write(`tool events: ${events.length}${shown.length < events.length ? ` (showing last ${shown.length})` : ''}\n\n`);
for (const e of shown) {
  process.stdout.write(`${e.ts}  ${e.kind.padEnd(14)} ${e.detail}\n`);
}
