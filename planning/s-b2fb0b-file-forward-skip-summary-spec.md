# Task: Collapse file-forward per-file skip messages into one summary (status + log)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is a
worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `runner/CLAUDE.md` first**, then the context below. You are on branch
`sonnet/file-forward-skip-summary`.

## Why (context — read before writing code)

When file-forward (`emitNewFiles`) has more candidate files than the caps allow, it
emits **one `status` protocol message AND one log line per skipped file**. Each
`status` is posted to the Slack thread as an in-place `chat.update`
(`src/sessions/manager.ts:739`), so a large over-cap turn rapidly overwrites the
placeholder with "skipped file …" names (a flicker that's effectively useless to the
user) and floods the gateway log (~290 lines observed in one turn). The dominant
trigger — cloned repos entering the candidate list — was removed in `d2b098`; this
slice is the **residual**: when the agent legitimately produces more than the caps
allow, give the user ONE clear, actionable summary instead of N noisy lines.

### Grounded facts (verified at `740ae3e`)

`emitNewFiles` in `runner/src/main.ts` (caps at `:178-182`: `MAX_FILES_PER_TURN = 5`,
`MAX_FILE_BYTES = 8 MiB`, `MAX_TOTAL_BYTES = 16 MiB`). The loop `for (const f of
newFiles)` (`:1120`) has three skip branches, each currently `emit({type:'status',
...})` + `log(...)` + `continue`:

- `:1121-1129` count cap — `fileCount >= MAX_FILES_PER_TURN` →
  status `skipped file ${f.name}: per-turn file limit (${MAX_FILES_PER_TURN}) reached`,
  log `skipped file ${f.name} (file count cap)`.
- `:1130-1138` per-file size — `f.size > MAX_FILE_BYTES` →
  status `skipped file ${f.name}: file too large (${f.size} bytes, limit ${MAX_FILE_BYTES})`,
  log `skipped file ${f.name} (${f.size} bytes, over per-file cap)`.
- `:1139-1147` total size — `totalBytes + f.size > MAX_TOTAL_BYTES` (this `continue`s,
  it does NOT `break` — a later smaller file may still fit) →
  status `skipped file ${f.name}: total size limit (${MAX_TOTAL_BYTES} bytes) would be exceeded`,
  log `skipped file ${f.name} (would exceed total bytes cap)`.

After the branches, files are read + forwarded (`fileCount++`, `emit({type:'file'…})`,
`log('forwarded file …')`, `:1149-1172`). The `status`/`file` protocol types are in
both `protocol.ts` copies — **no protocol change is needed** (reuse `status`).

## CRITICAL — do not stop after exploration

Make the edit, update/add tests, run `npm run gate`, fix failures, then stop.

## Implementation — accumulate, emit one summary

In `emitNewFiles`, replace the three per-file `emit(status)+log` skip emissions with
counters, and emit a **single** summary `status` + a **single** summary `log` AFTER
the loop (only if anything was skipped). Keep the decision logic and the
`continue`/non-`break` behavior of each branch exactly as-is — only move where the
user/log message is produced.

- Track per-reason counts (and keep the loop's existing `fileCount`/`totalBytes`
  accounting unchanged):
  ```ts
  let skippedCountCap = 0;     // hit the 5-file limit
  let skippedTooLarge = 0;     // single file over MAX_FILE_BYTES
  let skippedTotalCap = 0;     // would exceed MAX_TOTAL_BYTES
  ```
  In each branch, increment the matching counter and `continue` (drop the per-file
  `emit`/`log`).
- After the loop, if `skippedCountCap + skippedTooLarge + skippedTotalCap > 0`, build
  ONE summary and emit it once:
  ```ts
  const skippedTotal = skippedCountCap + skippedTooLarge + skippedTotalCap;
  const reasons: string[] = [];
  if (skippedCountCap > 0) reasons.push(`${skippedCountCap} over the ${MAX_FILES_PER_TURN}-file limit`);
  if (skippedTooLarge > 0) reasons.push(`${skippedTooLarge} too large (>${MAX_FILE_BYTES} bytes)`);
  if (skippedTotalCap > 0) reasons.push(`${skippedTotalCap} over the ${MAX_TOTAL_BYTES}-byte total`);
  const summary = `${skippedTotal} file${skippedTotal === 1 ? '' : 's'} not delivered: ${reasons.join(', ')}`;
  emit({ type: 'status', id, text: summary });
  log(`file-forward: ${summary}`);
  ```
  Wording is at your discretion but must: name the count, name each reason that
  fired, be ONE status + ONE log line total. Do NOT include every filename (that's
  the spam we're removing) — counts + reasons only. Privacy invariant: counts/sizes
  only, no message contents.
- The success path (`forwarded file …` log + `file` emit) is unchanged.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. Update the existing `emitNewFiles` tests that assert the
   old per-file skip statuses (in `runner/test/runner-main.test.ts`) to the new
   single-summary behavior.
2. When N files are skipped (mix of reasons), exactly ONE `status` message is emitted
   from the skip path, and it names the total and each reason that fired. Forwarded
   files still emit their `file` messages. Add/adjust a test that:
   - feeds >5 small files (via the faked `listFiles`/`readBinaryFile`), asserts 5
     `file` messages + exactly one summary `status` containing the count over the
     5-file limit;
   - (at least one assertion) covers an over-size or over-total reason appearing in
     the summary.
3. No per-file "skipped file …" `status` is emitted anymore (assert the absence of
   multiple skip statuses for a many-file over-cap turn).

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- Runner-only change to `emitNewFiles`. Do NOT touch `protocol.ts` (reuse `status`),
  the gateway, the caps values, the mtime filter, or the `.git`-subtree skip from
  `d2b098`. Do NOT change which files are forwarded — only how skips are reported.
- Never log message contents/tokens (counts + sizes + reasons only). No `any`, no
  `@ts-ignore`. NodeNext ESM.
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope

- The `.git`-subtree exclusion (already shipped in `d2b098`); the mtime heuristic;
  any protocol change; surfacing dropped filenames to the user.

## When done — report precisely (with REAL command output)

- What changed (file by file, one line each).
- The tail of `npm run gate` — test count + file count.
- Confirmation: one summary status replaces the per-file skips; forwarded files
  unaffected. Any deviation + why.
