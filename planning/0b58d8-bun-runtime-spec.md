# Task: support zip-archive runtimes and pin Bun in the catalog (enables `provision_runtime('bun')`)

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc). **Read the root `CLAUDE.md` first** (gate, invariants), then the context below.
You are on branch `sonnet/0b58d8-bun-runtime`. Tracks `track 0b58d8`.

## Context — the gap

`provision_runtime(<name>)` downloads a pinned, relocatable runtime onto the session volume,
verifies its sha256, and extracts it. Today the extractor only handles **tar.gz** —
`src/oneshot/docker-git-node.ts:507-532` (`dockerProvisionArgs`) does `mktemp …tar.gz` +
`tar -xzf`. The only catalog entry (`config/runtimes.json`, `python`) is a tar.gz. **Bun
ships only as a `.zip`**, so to add it we must teach the provisioner a second archive format
and ship the `unzip` tool in the runner image.

This slice: add an optional `format` field to the runtime catalog (default `tar.gz`, accept
`zip`), branch extraction on it, add `unzip` to the runner image, and pin Bun.

### Verified facts to use verbatim (do not re-derive)

- Bun release: **`bun-v1.3.14`**, glibc baseline build (the runner is `node:22-bookworm-slim`
  = glibc; baseline avoids an AVX2 SIGILL on older/virtualized CPUs).
- URL: `https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip`
- sha256 (verified by download): `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7`
- The zip extracts to `bun-linux-x64-baseline/bun`, so **`binSubdir` = `bun-linux-x64-baseline`**.

## CRITICAL — do not stop after exploration

Do NOT pause or yield until implemented AND `npm run gate` passes. Make every edit, add
tests, run the gate, fix failures, then stop. Zero-file-change yield is a failure.

## CRITICAL — this slice has a live step the offline gate cannot cover

Provisioning Bun for real needs the rebuilt image + Docker, which the offline gate does NOT
run (see `docs/DOGFOODING.md` "the sandbox can't run the live smokes"). So make the
**shell-command construction unit-testable** and assert it; the gate proves the args are
right, a human smoke proves the download/extract. Do not add any network/Docker to the suite.

## The change, layer by layer

### 1. Catalog type + parser — add `format` (`src/config.ts`)

- Add `format: 'tar.gz' | 'zip'` to the `RuntimeCatalogEntry` interface (`config.ts:72`).
- In `parseRuntimeCatalog` (`:247`): read `value['format']`. It is **optional in the JSON** —
  default to `'tar.gz'` when absent (keeps the existing `python` entry valid). When present it
  must be exactly `'tar.gz'` or `'zip'`, else throw
  `Invalid runtime catalog entry "<name>": format must be "tar.gz" or "zip"`. Set the parsed
  entry's `format` so downstream code always has a concrete value.

### 2. The other `RuntimeCatalogEntry` copy (`src/runner/runtime-provision-service.ts:7`)

`git-node.ts` imports its `RuntimeCatalogEntry` from here (the provision path uses it). Add the
same `format: 'tar.gz' | 'zip'` field so the two structurally-identical types stay assignable.
Let `tsc` flag any other site that now needs the field.

### 3. Extraction branch (`src/oneshot/docker-git-node.ts`, `dockerProvisionArgs`)

Today the body hardcodes (lines ~519, ~528):
```
'archive="$(mktemp /tmp/runtime.XXXXXX.tar.gz)"',
...
'tar -xzf "$archive" -C "$tmp_dir"',
```
Branch both lines on `req.entry.format`:
- `tar.gz` → temp suffix `.tar.gz`, extract `tar -xzf "$archive" -C "$tmp_dir"` (unchanged).
- `zip` → temp suffix `.zip`, extract `unzip -q "$archive" -d "$tmp_dir"`.
Everything else (the sha256 verify, the `bin_dir` existence short-circuit, the atomic
`mv "$tmp_dir" "$target"`, the final `test -d "$bin_dir"`) stays identical. Keep the
`set -eu` + cleanup trap. Build the command the same way (a string array joined by `; `); just
select the suffix and extract verb from the format.

### 4. Runner image — ship `unzip` (`runner/Dockerfile`)

Add `unzip \` to the `apt-get install` list (alongside `git`, `curl`, `ripgrep` at line ~6).
Note in your report that this needs an image rebuild (`docker build -t slackbot-runner runner/`)
to take effect live — it is not exercised by the offline gate.

### 5. Pin Bun (`config/runtimes.json`)

Add a `bun` entry next to `python`, using the verified facts above:
```json
"bun": {
  "version": "1.3.14",
  "url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip",
  "sha256": "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
  "binSubdir": "bun-linux-x64-baseline",
  "format": "zip"
}
```
Leave the `python` entry untouched (no `format` field → defaults to `tar.gz`).

### 6. Docs

- **`docs/DOGFOODING.md`** — add an **"## Adjacent-owned repos"** section after the tiers:
  the category for repos the org owns but that are not the self-host (e.g.
  `briggsd/code-reviewer`, the AI review factory). Cover: no runtime/permission-boundary blast
  radius (it doesn't spawn the bot), but it *is* the review net, so a bad merge degrades review
  for every repo including slack-agent's own PRs — keep its review-engine core human-reviewed,
  treat the rest like Tier-2 (supervised + approval gate). Note the enablement: it's a `bun`
  repo, so `provision_runtime('bun')` (now available) supplies the toolchain, and the operator
  sets `ONESHOT_CHECK_CMDS` for it to run its full gate (`{"briggsd/code-reviewer":{"test":"bun run gate"}}`),
  plus the clone allowlist + PAT scopes, exactly like the self-repo setup above. Keep the dogfood
  knobs env/operator-controlled (uncommitted), matching the existing section. Match the file's
  voice; no new guardrail code in this slice.
- **`.env.example`** — update the `RUNTIME_CATALOG_PATH` comment that says it "pins one Python
  standalone runtime" to "pins Python and Bun standalone runtimes."
- **`README.md`** — in the `provision_runtime` paragraph (under Sandbox runner), note the catalog
  ships pinned Python and Bun, and that zip- and tar.gz-format runtimes are both supported. Keep
  it to a sentence or two.

## Acceptance criteria

1. `npm run gate` passes; test count rises. The real `config/runtimes.json` parses at startup
   with both entries (python defaulting to `tar.gz`, bun `zip`).
2. `parseRuntimeCatalog` accepts `format: 'zip'`, defaults a missing `format` to `'tar.gz'`,
   and rejects any other `format` value at startup (fail-closed, like the other catalog checks).
3. `dockerProvisionArgs` emits `unzip -q … -d …` (and a `.zip` temp name) for a `zip` entry,
   and the unchanged `tar -xzf …` (`.tar.gz` temp) for a `tar.gz` entry — verified by a unit
   test on the constructed command, no Docker.
4. `runner/Dockerfile` installs `unzip`.
5. The bun entry is pinned exactly as specified (url, sha256, binSubdir, format).

## Tests

- **`test/config.test.ts`** — extend the `parseRuntimeCatalog` tests: a `zip` entry parses;
  a missing `format` defaults to `tar.gz`; `format: "rar"` (or any other) throws; the existing
  python-style entry still parses. If there's an existing test that loads the real
  `config/runtimes.json`, make sure bun is covered (or add one that parses the shipped file and
  asserts `bun.format === 'zip'`, `bun.binSubdir === 'bun-linux-x64-baseline'`).
- **`test/docker-git-node.test.ts`** — assert the provision command construction: for a `zip`
  entry the joined shell command contains `unzip -q` and a `.zip` mktemp suffix and NOT
  `tar -xzf`; for a `tar.gz` entry it contains `tar -xzf` and `.tar.gz` and NOT `unzip`. Use the
  existing harness/fakes in that file; assert against the args array `dockerProvisionArgs`
  produces (expose it for the test the same way the file already tests command construction, or
  drive `provisionRuntime` against the fake spawn and inspect the captured argv).

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** (pass/fail counts) + `git diff --stat`.
- No `any`, no `@ts-ignore`, no non-null `!`. `NodeNext` ESM; honor `exactOptionalPropertyTypes`
  (the JSON `format` is optional; the parsed `RuntimeCatalogEntry.format` is concrete).
- The catalog is the gate: callers still name only a runtime, never a URL. Keep the sha256
  verify before extraction. Never weaken `--proto "=https" --tlsv1.2` or the verify step.
- No new runtime deps. Do NOT commit. Do NOT `git add -A`. (The spec is already committed as the
  branch's first commit.)

## Out of scope

- Actually running the bot on `briggsd/code-reviewer` (operational; needs the rebuilt image +
  tokens + a human Docker smoke).
- A startup guardrail for adjacent repos (the self-repo `assertDogfoodGate` stays as-is).
- arm64 / musl bun builds, or a non-baseline bun. Multi-arch catalog entries.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each), incl. test + doc files.
- Real tail of `npm run gate` (pass/fail counts) + `git diff --stat`.
- State old vs new test count.
- Confirm the shipped `config/runtimes.json` parses (e.g. the test that loads it is green).
- Call out explicitly that the runner image must be rebuilt for `unzip`/bun to work live, and
  that live provisioning is a human Docker smoke (not covered by the gate).
- Any deviation from this spec and why.
