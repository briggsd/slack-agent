# Task: Derive the `run_checks` PATH prefix from the runtime catalog's `binSubdir`, not a glob for dirs named `bin`

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-b9d537-runtime-path`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/b9d537-runtime-path`.

## Context — read before writing code

When the agent provisions a runtime (`provision_runtime`), the binary is unpacked to
`/workspace/.runtimes/<name>/<binSubdir>` on the session volume (e.g. python →
`/workspace/.runtimes/python/python/bin`, bun → `/workspace/.runtimes/bun/bun-linux-x64-baseline`).
A later `run_checks` invocation needs those binaries on `PATH` so the project's
configured check command can use the provisioned interpreter.

Today the PATH prefix is built by **globbing for directories literally named `bin`**:

`src/oneshot/docker-git-node.ts:275-278`
```ts
function runtimePathPrefixScript(): string {
  return 'runtime_bins="$(find /workspace/.runtimes -mindepth 2 -maxdepth 3 -type d -name bin -print 2>/dev/null | tr \'\\n\' :)"; ' +
    'if [ -n "$runtime_bins" ]; then export PATH="${runtime_bins}$PATH"; fi';
}
```

**The bug this fixes:** the glob only finds runtimes whose bin dir is *named* `bin`.
Python's `binSubdir` is `python/bin` (a `bin` dir exists → found ✓). Bun's `binSubdir`
is `bun-linux-x64-baseline` (no dir named `bin` → **NOT found** ✗). So a provisioned
bun — verified end-to-end by the live smoke for #77 — is invisible to `run_checks`.
The fix derives the PATH prefix from the catalog's authoritative `binSubdir` values
instead of guessing from directory names.

### Code this builds on

- `src/oneshot/docker-git-node.ts` — `DockerGitNodeExecutor`. Holds the only caller of
  `runtimePathPrefixScript()` (at `dockerCheckArgs`, line ~494). The constructor
  (line ~290) already takes injected options (`lintCmd`, `testCmd`, `checkCmds`,
  `cloneTimeoutMs`, `provisionTimeoutMs`); add the catalog here the same way.
  `shellQuote(value)` (line ~271) single-quotes a string for safe shell embedding — use it.
- `src/config.ts` — `RuntimeCatalogEntry` (line ~72; fields include `binSubdir: string`)
  and `parseRuntimeCatalog` → `ReadonlyMap<string, RuntimeCatalogEntry>`. Both the runtime
  `name` (catalog key, `isSafeRuntimeName`) and `binSubdir` (`isSafeRuntimeBinSubdir`) are
  **validated at parse time** to be safe path segments — but still `shellQuote` the emitted
  path literals as defense-in-depth, consistent with the rest of the file.
- `src/index.ts` — wires the executor. At line ~112 `new DockerGitNodeExecutor({...})` is
  constructed, and `oc.runtimeCatalog` (a `ReadonlyMap<string, RuntimeCatalogEntry>`) is
  already in scope there (it's passed to `RealRuntimeProvisionService` at line ~123). Pass
  the same `oc.runtimeCatalog` into the executor.
- `config/runtimes.json` — the live catalog: `python` (`binSubdir: "python/bin"`) and
  `bun` (`binSubdir: "bun-linux-x64-baseline"`).

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate passes.
Make every edit, add/update tests, run the gate, fix failures, then stop. Yielding after
only exploring (zero file changes) is a failure — implement end to end in this run.

## What to implement

1. **Thread the catalog into `DockerGitNodeExecutor`.**
   - Add an optional constructor field `runtimeCatalog?: ReadonlyMap<string, RuntimeCatalogEntry>`
     (default to an empty `Map`), stored on the instance like the other options. Import
     `RuntimeCatalogEntry` from `../config.js` (the type `index.ts`'s `oc.runtimeCatalog` uses).
   - In `src/index.ts`, pass `runtimeCatalog: oc.runtimeCatalog` into the
     `new DockerGitNodeExecutor({...})` call.

2. **Rewrite the PATH prefix to be catalog-derived.** Turn `runtimePathPrefixScript()` into an
   instance method (or pass it the catalog) that emits, for each catalog entry, the candidate
   directory `/workspace/.runtimes/<name>/<binSubdir>` and prepends it to `PATH` **only if it
   exists** (a runtime is on PATH only when it was actually provisioned this session — preserve
   the existing "exists-only" semantics the glob gave for free). Keep the call site at
   `dockerCheckArgs` working (`${...}; ${shellCmd}`).

   Required shell shape — **must remain a single valid `sh` statement for any catalog, including
   empty** (the old code was always valid; the call site concatenates `"<script>; <shellCmd>"`,
   so an empty/`""` return would produce a leading `;` syntax error):
   - **Non-empty catalog:** build a `runtime_bins` accumulator over the explicit dirs, e.g.
     ```sh
     runtime_bins=''; for d in <q-dir-1> <q-dir-2>; do if [ -d "$d" ]; then runtime_bins="${runtime_bins}${d}:"; fi; done; if [ -n "$runtime_bins" ]; then export PATH="${runtime_bins}$PATH"; fi
     ```
     where each `<q-dir-N>` is `shellQuote('/workspace/.runtimes/' + name + '/' + binSubdir)`.
     Keeping the `runtime_bins` / `export PATH="${runtime_bins}$PATH"` shape mirrors the original.
   - **Empty catalog:** return a harmless no-op statement (`:`) so the concatenated command is
     still valid and does nothing to PATH.
   - Iterate the catalog in its natural (insertion) order so output is deterministic.
   - **The glob is fully removed** — no `find`, no `-name bin` left anywhere.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the updated/new ones);
   `boundaries` clean; strict TS, no `any`, no `@ts-ignore`.
2. For a catalog with python (`binSubdir: python/bin`) and bun (`binSubdir: bun-linux-x64-baseline`),
   the `run_checks` shell command (the `-c` arg of the `docker run`) contains BOTH
   `/workspace/.runtimes/python/python/bin` AND `/workspace/.runtimes/bun/bun-linux-x64-baseline`,
   each guarded by an existence test (`[ -d ` …), and prepends them via
   `export PATH="${runtime_bins}$PATH"`. It contains **no** `-name bin` glob.
3. With **no** catalog configured (empty), the `run_checks` shell command contains no
   `/workspace/.runtimes` PATH manipulation (the prefix is the `:` no-op) and the check command
   itself still runs (e.g. `npm run lint`). No leading-`;` / syntax breakage.
4. The credential boundary is unchanged: no `GIT_TOKEN` in the check spawn args/env.
5. New/updated tests in `test/docker-git-node.test.ts` cover criteria 2–4.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`, = `npm run check` + `npm run boundaries`) must pass; **paste the
  tail of its output** when done. Run it yourself in this worktree (`node_modules` is symlinked,
  offline — no Slack/Docker/API/network).
- **No `any`, no `@ts-ignore`.** Find the real type (`RuntimeCatalogEntry` from `../config.js`).
- **Shell-safety:** emit every path via `shellQuote`. Do not interpolate raw `name`/`binSubdir`
  into the command string.
- **Keep the diff focused:** `src/oneshot/docker-git-node.ts`, `src/index.ts`, and
  `test/docker-git-node.test.ts` only. Do NOT touch `protocol.ts`, the provision/extract path
  (`dockerProvisionArgs`), `config/runtimes.json`, or unrelated code.
- **Do not modify this spec file.**

## Invariants this slice touches (do not break — some are boundary-enforced)

- `@slack/bolt` only in `src/index.ts`; the gateway never imports the Agent SDK or the `runner/`
  package. (You're editing gateway-side `src/oneshot/` + `src/index.ts` — fine.)
- The gateway never runs agent code; the container is the permission boundary. This PATH prefix
  runs **inside** the check container, which is correct — you are only changing how the in-container
  command string is built, not where it runs.
- Never log message contents or tokens.

## Test infrastructure — where to assert (front-load this)

All offline, in `test/docker-git-node.test.ts`:

- The suite already has a `FakeChildProcess` + `makeFakeSpawn(exitCode)` helper returning
  `{ spawnFn, calls }`, where `calls[0].args` is the captured `docker` argv. The standard
  assertion pattern (see the existing `runCheck` describe block, ~line 861):
  ```ts
  const { spawnFn, calls } = makeFakeSpawn(0);
  const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn /*, runtimeCatalog */ });
  await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
  const { args } = calls[0]!;
  const shellCmd = args[args.indexOf('-c') + 1] ?? '';
  // assert on shellCmd
  ```
- **The existing test at ~line 928** ("prepends provisioned runtime bin directories to PATH
  without injecting credentials") currently asserts the OLD glob (`find /workspace/.runtimes`,
  `-type d -name bin`). **Update it**: construct the executor WITH a small `runtimeCatalog`
  fixture (python + bun entries — a `new Map<string, RuntimeCatalogEntry>([...])` with the two
  `binSubdir`s; the other entry fields like `version`/`url`/`sha256`/`format` can be dummy-but-valid
  shapes since only `binSubdir` is read for PATH), then assert criterion 2 (both derived dirs,
  the `[ -d ` guard, the `export PATH="${runtime_bins}$PATH"`, and that `-name bin` is GONE).
- **The two override tests** at ~line 944 (`lintCmd`) and ~line 956 (`testCmd`) assert
  `args[cIdx+1]).toContain('/workspace/.runtimes')`. Since the prefix is now catalog-derived,
  an executor built without a catalog no longer contains `.runtimes`. Give those two a
  `runtimeCatalog` (reuse the fixture) so the `.runtimes` assertion stays meaningful, OR drop the
  incidental `.runtimes` assertion from them (they're really about the override command). Pick one
  and keep them green.
- **Add a new test** for criterion 3: executor with no catalog → `shellCmd` does NOT contain
  `/workspace/.runtimes`, and still contains the default check command (`npm run lint`).
- Keep/extend the credential-boundary assertion (criterion 4: `args` does not contain `GIT_TOKEN`).

## Report (when done)

- The tail of `npm run gate` (real pass/fail counts — not a paraphrase).
- `git status --short` + `git diff --stat`.
- One line per acceptance criterion: how it's met and which test covers it.
- Note any place the real types/API differed from this spec and what you did instead.
