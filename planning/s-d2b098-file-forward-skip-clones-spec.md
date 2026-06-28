# Task: Stop file-forward from dumping cloned-repo files into Slack — skip git-repo subtrees in the workspace walker

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is
a worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `runner/CLAUDE.md` first**, then the context below. You are on
branch `sonnet/file-forward-skip-clones`.

## Why (context — read before writing code)

After each successful turn the runner "file-forwards" files the agent produced into
the Slack thread (so a generated SVG/CSV/etc. reaches the user). It selects files by
**modification time** — `emitNewFiles` forwards everything under `/workspace` whose
mtime is newer than the turn start (`runner/src/main.ts:1115`,
`f.mtimeMs >= turnStartMs`). That misfires on **review tasks**: `clone_repo` writes
the whole target repo to `/workspace/<owner>-<repo>/` *during the turn*, so every
cloned file gets a fresh mtime and passes the filter. Observed live: a review turn
uploaded `AGENTS.md`/`action.yml`/`biome.json`/`bun.lock` (alphabetical repo root)
as Slack snippets, and the over-cap remainder flooded the thread status with
per-file "skipped file …" messages.

The agent never *wrote* those files — it cloned them to read. Edits the agent makes
to a clone surface via the git/PR path, not file-forward. **Fix: the workspace
walker must not descend into a cloned repo.** A directory containing a `.git` entry
is a git repo root (or worktree) — skip its whole subtree.

This kills BOTH faces of the bug at once: nothing to dump (issue d2b098) AND no
per-file skip-spam (issue b2fb0b's dominant trigger), because the cloned files never
enter the candidate list.

### Grounded facts (verified at `c86870a`; `design/` is gitignored — inlined here)

- **The walker**: `realListFiles(dir)` in `runner/src/main.ts:1198-1238` — the real
  `ListFilesFn` impl, wired at `main.ts:1567` (`listFiles: realListFiles`). Its inner
  `walk(currentDir)` (1202) `readdir`s `currentDir` with `{ withFileTypes: true }`
  into `entries` (1205-1206; `catch { return }` on error at 1207-1209), then for each
  entry: skips dotfiles + `node_modules` (`shouldSkipName(name) || name ===
  'node_modules'`, 1211-1214), recurses into subdirs (1216-1217), and `stat`s + pushes
  regular files (1218-1230). `.git` itself is already skipped as a dotfile — but the
  cloned-repo *parent* dir (e.g. `briggsd-code-reviewer`) is NOT a dotfile, so the
  walker descends into it and emits its non-dotfile children. Results sorted by path
  (1236).
- `ScannedFile = { path; name; size; mtimeMs }` (`main.ts:73-78`); `ListFilesFn =
  (dir) => Promise<ScannedFile[]>` (84). `shouldSkipName(name)` = `name.startsWith('.')`
  (1092).
- **`realListFiles` is NOT exported** — it must be exported to unit-test the new skip
  directly (existing tests *fake* `listFiles`, so they never exercise the real walker).
- **`emitNewFiles`** (`main.ts:1100`) calls the injected `deps.listFiles`, not
  `realListFiles`. Its cap/skip-status loop (1120-1147) and the file-forward (1164-
  1172) are unchanged by this slice — do not touch them.
- Existing runner tests live in `runner/test/runner-main.test.ts` (fakes `listFiles`
  as `async () => [...]`). No test exercises `realListFiles`.

## CRITICAL — do not stop after exploration

Implement the edit, add tests, run `npm run gate`, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure.

## Implementation — exact change

### 1. Skip git-repo subtrees in `realListFiles.walk`

In `runner/src/main.ts`, inside `walk(currentDir)`, immediately AFTER the `readdir`
try/catch that populates `entries` (i.e. right before the `for (const entry of
entries)` loop at 1210), add:

```ts
// A directory containing a `.git` entry is a cloned repo root (or git worktree):
// its files are not agent-authored artifacts — they reach the user via the git/PR
// path, not file-forward. Skip the whole subtree so a review of a cloned repo
// doesn't dump every repo file into Slack. `.git` may be a dir (normal clone) or a
// file (worktree gitlink) — match by name regardless of type.
if (entries.some((e) => e.name === '.git')) {
  return;
}
```

Notes:
- This naturally also prevents the repo root's own loose files from being forwarded
  — intended: the entire clone subtree is excluded. Artifacts the agent wants
  delivered must live under `/workspace` itself (or a non-repo subdir), per the
  existing `WORKSPACE_SYSTEM_PROMPT_ADDITION`.
- Uses the already-read `entries` — no extra I/O.
- `/workspace` root is the session root, not a clone (clones go to subdirs), so it
  won't be skipped in practice; if it ever were a repo, stopping file-forward is the
  correct defensive behavior.

### 2. Export `realListFiles`

Change `async function realListFiles` → `export async function realListFiles`
(`main.ts:1198`) so the new test can call it against a real temp dir. No other
behavior change.

## Acceptance criteria (each maps to a test or observable behavior)

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`. All existing tests still pass.
2. A new test exercises the REAL `realListFiles` against a real temp directory
   (use `fs/promises` `mkdtemp` under `os.tmpdir()`; clean up in a `finally`/
   `afterEach`). Build this tree and assert the result set:
   - `<tmp>/loose.txt` → **included** (loose artifact at the scanned root).
   - `<tmp>/myrepo/.git/HEAD` (so `myrepo` has a `.git` **directory**) +
     `<tmp>/myrepo/README.md` + `<tmp>/myrepo/src/index.ts` → repo files
     **excluded** (whole `myrepo` subtree skipped).
   - `<tmp>/worktree/.git` as a **file** (gitlink) + `<tmp>/worktree/code.ts` →
     `worktree` subtree **excluded** (`.git` matched as a file too).
   - `<tmp>/node_modules/pkg/index.js` → **excluded** (existing behavior preserved).
   - `<tmp>/.hidden` dotfile → **excluded** (existing behavior preserved).
   Assert by `name`/`path`: exactly `loose.txt` is returned (and not any repo/
   node_modules/dotfile path). Tests are offline — a temp fs is allowed (no Slack/
   Docker/API/network); do not mock `fs`.
3. (Optional but preferred) A focused assertion that a nested non-repo subdir is
   still walked (e.g. `<tmp>/sub/keep.txt` → included) so the change only excludes
   git-repo subtrees, not all subdirs.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail when done.
- Runner-only change. Do NOT touch `protocol.ts` (no protocol change), the gateway
  (`src/`), `emitNewFiles`'s cap/forward loop, or the mtime filter itself.
- No `any`, no `@ts-ignore`; NodeNext ESM (`.js` import specifiers). Strict TS.
- Tests stay offline. A real temp directory via `fs/promises` is fine; no network/
  Docker/Slack/API. Always clean up the temp dir.
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope (do NOT build)

- Collapsing the per-file "skipped file …" statuses into one summary — that's the
  residual UX/log fix tracked in **b2fb0b**; this slice removes the dominant trigger
  (cloned files entering the candidate list) but leaves the cap-status code as-is.
- Replacing the mtime heuristic with git-aware diffing, or any change to which loose
  artifacts are forwarded.
- The subagent-survey prompt nudge (22c224) and any heartbeat/timeout work (89ab70,
  already shipped).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real) — test count + file count.
- Confirmation the new test exercises the REAL `realListFiles` (not a fake) and
  cleans up its temp dir.
- Any deviation from this spec and why; anything a unit test can't catch.
