# Task: File forwarding — agent-generated files land in the Slack thread

You are implementing one slice in `/home/jedanner/workspace/slackbot` (TypeScript, Node 20+,
ESM, vitest, strict tsc). Read `planning/ARCHITECTURE.md` first, then the M2 code this builds
on: `src/runner/protocol.ts` + `runner/src/protocol.ts` (NDJSON protocol),
`runner/src/main.ts` (runner turn loop), `src/runner/docker.ts` (gateway-side event mapping),
`src/sessions/manager.ts` (event consumption), `src/slack/responder.ts` (`SlackClientLike`).
You are on branch `feat/m3-file-forwarding`.

Motivating bug: a user asked the agent for an SVG; the agent wrote it to `/workspace` but
the user got only text. Files the agent produces during a turn must be uploaded to the
Slack thread.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the test gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding after
only exploring (with zero file changes) is a failure — implement end-to-end in this run.

## Acceptance criteria

1. `npm run check` passes (all existing 59 tests must keep passing).
2. **Protocol** (update BOTH copies, `src/runner/protocol.ts` and `runner/src/protocol.ts`,
   keeping them identical): new runner→gateway message
   `{"type":"file","id":<turn id>,"name":"<basename>","data_base64":"...","size":<bytes>}`.
   Emitted zero or more times per turn, before the final `text`/`error`.
3. **Runner — detect files written during the turn** (`runner/src/main.ts`):
   - Record a turn-start timestamp; after the SDK turn completes (success only), scan
     `/workspace` recursively for **regular files with mtime >= turn start**, skipping:
     dotfiles/dot-directories (`.slackbot`, `.git`, …), `node_modules`, symlinks, and
     anything above per-file/total caps.
   - Caps (constants): max 5 files/turn, max 8 MiB per file, max 16 MiB total; on breach,
     skip the offending file and emit a `status` event naming what was skipped.
   - Emit one `file` message per detected file (base64 content), then the final `text`.
   - The scan must be injectable for tests (inject a `listFiles`/`readFile`-style seam next
     to the existing `ReadFileFn`/`WriteFileFn` seams — follow the established pattern).
   - Tell the agent about the convention: pass a system-prompt addition via the SDK options
     (check `Options` in `runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for
     the system-prompt field — expected: a `systemPrompt` option supporting an append/preset
     form; use whatever the `.d.ts` actually offers) saying roughly: "Files you save under
     /workspace are automatically delivered to the user at the end of your turn. When asked
     to produce a file, save it there." Ground this in the `.d.ts` — do not guess.
4. **Gateway — RunnerEvent + upload**:
   - Extend `RunnerEvent` (`src/runner/types.ts`) with
     `{ type: 'file'; name: string; data: Buffer }`.
   - `DockerRunner.send()` maps protocol `file` messages (matching the turn id) to that
     event (decode base64 → Buffer). Malformed base64 → a `status` event noting a skipped
     file, not a crash.
   - `SlackClientLike` gains `uploadFile(params: { channel: string; thread_ts: string;
     filename: string; data: Buffer }): Promise<void>`. Implement it in `src/index.ts` with
     the Bolt web client's `files.uploadV2` — **verify the exact method + param names in
     `node_modules/@slack/web-api` types** (expected: `channel_id`, `thread_ts`, `file`,
     `filename`); do not guess.
   - `SessionManager.drain()` handles `file` events: upload into the session's thread;
     upload failures update the placeholder with a readable error but do not abort the turn.
   - `FakeSlackClient` (tests) records uploads in an `uploads` array.
5. **FakeRunner** (`src/runner/fake.ts`): scripts may now include `file` events (type union
   already covers it — make sure nothing narrows it out).
6. **README**: document the new required Slack scope **`files:write`** (manifest snippet
   updated too) and the "save files under /workspace" behavior.

## Test infrastructure (do not skip)

Follow the established idioms (capture fakes, injectable seams, fake timers where needed):
- Runner tests (`runner/test/runner-main.test.ts`): fake fs seam returning scripted files —
  file detected → `file` emitted before `text`; mtime older than turn start → not emitted;
  caps enforced (oversize file skipped + status emitted); dotfile/node_modules skipped;
  scan only on success (no scan after SDK error).
- Gateway tests (`test/docker.test.ts`): protocol `file` line → `file` RunnerEvent with
  decoded Buffer; bad base64 → status not crash. (`test/manager.test.ts`): file event →
  `FakeSlackClient.uploads` entry with channel/thread/filename; upload rejection → error
  text lands on placeholder, turn still completes.
- Aim ≥ 12 new tests. All offline.

## Hard constraints (do NOT violate)

- **The test gate must pass** (`npm run check`); paste its real tail.
- Same strict tsconfig; no `any`, no `@ts-ignore`. No new runtime deps anywhere.
- Keep the two protocol.ts copies byte-identical.
- Never log file contents or message contents; log filenames + sizes only.
- Do NOT touch the dedup/reap logic in listener/manager beyond the drain() addition.
- Do NOT commit — leave the working tree for coordinator review.

## Out of scope

- Inbound files (user uploads Slack→agent). Streaming text. Volume GC.

## When done — report precisely (with REAL command output)

RUN and paste the ACTUAL output of `git status --short`, `git diff --stat`, and the full
gate tail with pass/fail counts. Do not describe any change you cannot point to in the
diff. Then: (1) files changed and why; (2) the exact SDK `Options` field and `@slack/web-api`
method/params you used, with the `.d.ts` locations; (3) how tests cover detection, caps,
mapping, and upload; (4) anything not satisfied.
