# Task: Add `lint` and `test` deterministic nodes with auto-detect + override command discovery

You are implementing one slice in the slack-agent repo (in an isolated worktree off branch
`sonnet/m5-s04b3-lint-test`). TypeScript, Node 20+, ESM (`.js` import specifiers), vitest, strict
tsc. **Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the context below.

## Context — read before writing code

The one-shot repo-work flow is a declarative blueprint. Today (after S04b-2) the node list is
`clone → research → plan → branch → implement → push → open-pr` (`src/oneshot/repo-oneshot.ts`).
This slice adds **`lint` and `test` deterministic nodes** after `implement`, so the implemented
change is checked before the PR opens. Target order:
`clone → research → plan → branch → implement → lint → test → push → open-pr`.

**Scope boundary that drives the whole design — read carefully:** this slice *runs* lint/test and
*captures* their results; it does **NOT gate** on them. A failing check is recorded into `ctx` and
surfaced as a status, but the run continues and the PR still opens. The bounded-retry loop and the
failure classifier that *act* on these results are sub-slice 2c (out of scope here). Making lint/test
block the PR now would be a regression — most target repos would fail a check and never get a PR.

Code this builds on (all under `src/oneshot/`):
- `git-node.ts` — the `GitNodeExecutor` interface + `CloneRequest`/`PushRequest`/`BranchRequest`.
  **This is the contract you extend** with a check operation.
- `docker-git-node.ts` — `DockerGitNodeExecutor`. Study `branch()` (PR #16): it runs a *no-credential*
  local op via `dockerRunArgs` + `runDocker(spawnFn, args, '', …)`. `dockerRunArgs(volume, gitArgs)`
  forces `--entrypoint git` and injects `-e GIT_TOKEN`. `runDocker(...)` **rejects** on non-zero exit
  and captures up to 500 chars of stderr.
- `fake-git-node.ts` — `FakeGitNodeExecutor`, records calls (`clones`/`branches`/`pushes`/`changeRequests`)
  and has `failNextX` scripting. Mirror its style for checks.
- `nodes/clone.ts`, `nodes/branch.ts` — deterministic node shape; `nodes/implement.ts` — the node
  before yours.
- `repo-oneshot.ts` — the node list. `context.ts` — `OneShotContext` (`workdir`, `volume`, accumulators
  like `implementSummary?`) and `OneShotDeps` (`inner`, `gitNodes`).
- `../config.ts` — `OneShotConfig` (env → config). `../index.ts` and `../harness/cli.ts` — the two
  composition roots that construct `DockerGitNodeExecutor` (look for `new DockerGitNodeExecutor({ image: … })`).

Test infra (offline — no Docker/network):
- `test/docker-git-node.test.ts` — the executor unit tests. It injects a fake `SpawnFn` via
  `makeFakeSpawn(exitCode)` returning a `FakeChildProcess` (has `stdout`/`stderr` `PassThrough`s and
  `simulateExit(code)`), and asserts the captured `calls[].args` (the docker argv). **This is your
  precedent for testing `runCheck`'s argv and exit/output handling** — you'll extend `makeFakeSpawn`
  (or add a variant) so a fake can write to stdout/stderr before exiting with a chosen code.
- `test/oneshot.test.ts` — the orchestrator behavior pin. `FakeRunner(key, script)` scripts the three
  agentic turns (research/plan/implement); `FakeGitNodeExecutor` records git ops. `test/blueprint.test.ts`
  has the node-name-order and node-kinds assertions.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate` passes. Make
every edit, add/adjust tests, run the gate, fix failures, then stop. Yielding after only exploring is a
failure — implement end to end in this run.

## Acceptance criteria

1. `npm run gate` passes (`npm run check` + `npm run boundaries`) — existing tests stay green after the
   order/wiring updates, plus new ones. Paste the real tail.
2. **Contract** in `src/oneshot/git-node.ts`:
   - `interface CheckResult { exitCode: number; output: string }`.
   - `interface CheckRequest { kind: 'lint' | 'test'; workdir: string; volume: string }` (**no lease** —
     checks need no credential).
   - `GitNodeExecutor` gains `runCheck(req: CheckRequest): Promise<CheckResult>`. Doc-comment that this
     runs the project's lint/test command in an ephemeral container on the volume, with **no credential**
     (the token never reaches lint/test — defense-in-depth on the boundary), and that a non-zero exit is a
     **returned result, not a thrown error** (the check ran and reported; failure is data).
3. **`DockerGitNodeExecutor.runCheck`** (`docker-git-node.ts`):
   - Constructor gains optional `lintCmd?: string` and `testCmd?: string` (the override commands); store them.
   - Build the docker argv with a new private helper (e.g. `dockerCheckArgs(volume, workdir, shellCmd)`):
     `['run','--rm','-v',`${volume}:/workspace`,'-w',workdir,'--security-opt','no-new-privileges','--entrypoint','sh',this.image,'-c',shellCmd]`.
     **Do NOT add `-e GIT_TOKEN`** — checks get no credential.
   - The shell command: if an override is configured for the kind, use it verbatim; otherwise the
     auto-detect default — exactly:
     `if [ -f package.json ]; then npm run <kind> --if-present; else echo "no package.json — skipping <kind>"; fi`
     (`--if-present` makes npm exit 0 when the script is absent; the package.json guard makes a non-npm
     repo skip cleanly with exit 0 — so a missing check never fails the run). Use a proper `if/then/else`,
     NOT `&& … || …` (the latter would mask a real non-zero exit).
   - Add a `runDockerCapture(spawnFn, args, what, context)` helper that resolves `{ exitCode, output }`
     (capture combined stdout+stderr, cap to a few KB), and **rejects only** on the child's `error`
     event (a true spawn/infra failure) — a non-zero command exit resolves normally. Use stdio
     `['ignore','pipe','pipe']`. Do not reuse `runDocker` (it rejects on non-zero).
4. **`FakeGitNodeExecutor.runCheck`** (`fake-git-node.ts`): record requests in a public `checks: CheckRequest[]`
   and return a scriptable result. Provide a setter, e.g. `setCheckResult(kind, result: CheckResult)`
   (default when unset: `{ exitCode: 0, output: '' }`). This lets tests drive a passing or failing check.
5. **`lint` node** (`src/oneshot/nodes/lint.ts`, `kind: 'deterministic'`, `name: 'lint'`): yield status
   `'linting…'`; call `deps.gitNodes.runCheck({ kind: 'lint', workdir: ctx.workdir, volume: ctx.volume })`;
   store into a new `ctx.lintResult`; yield a result status — `exitCode === 0` → `'lint passed'`, else
   `'lint failed (surfaced; not blocking until the retry loop lands)'`. **Do NOT throw on a non-zero exit.**
6. **`test` node** (`src/oneshot/nodes/test.ts`, `kind: 'deterministic'`, `name: 'test'`): same shape with
   `kind: 'test'`, statuses `'testing…'` / `'tests passed'` / `'tests failed (surfaced; not blocking until the retry loop lands)'`, stored into `ctx.testResult`. Do NOT throw on non-zero.
7. **`OneShotContext`** gains `lintResult?: CheckResult` and `testResult?: CheckResult`.
8. **Blueprint order** (`repo-oneshot.ts`):
   `[clone, research, plan, branch, implement, lint, test, push, openPr]`.
9. **Config + composition roots:**
   - `OneShotConfig` (`config.ts`) gains `lintCommand: string | undefined` and `testCommand: string | undefined`,
     read via `optionalEnvMaybe('ONESHOT_LINT_CMD')` / `optionalEnvMaybe('ONESHOT_TEST_CMD')`.
   - `src/index.ts` and `src/harness/cli.ts`: pass them into `new DockerGitNodeExecutor({ image, lintCmd, testCmd })`
     (index from `config.oneshot`; cli from `process.env` like its existing reads). Fake-backend branches are
     unchanged.
10. **Tests:**
    - `docker-git-node.test.ts`: `runCheck` builds the expected argv (entrypoint `sh`, `-w <workdir>`, **no**
      `-e GIT_TOKEN`, the default `if [ -f package.json ]…` command for each kind); when `lintCmd`/`testCmd`
      is configured the override command is used instead; a non-zero exit **resolves** with that `exitCode`
      (does not reject) and the captured stdout/stderr appears in `output`.
    - `oneshot.test.ts`: happy path now records two `runCheck` calls (`kind:'lint'` then `kind:'test'`, right
      `workdir`/`volume`); `'linting…'` and `'testing…'` statuses appear in order implement < lint < test < push;
      the terminal PR-url text still appears. **Add a non-gating test:** script `FakeGitNodeExecutor` so the
      lint check returns `{ exitCode: 1, output: 'boom' }` ⇒ the run still calls `push` and `openChangeRequest`
      and emits the `Opened PR:` text (a failing check does NOT block the PR in this slice).
    - `blueprint.test.ts`: node-name order → the 9 names above; node-kinds include `lint`/`test` as `deterministic`.

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the real tail.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); strict / `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes`.
- **Never log message contents or tokens.** Check output may contain repo content — keep it as `ctx`/event
  *data*; never `console.log` it. Checks get **no** `GIT_TOKEN`.
- Checks are `kind: 'deterministic'` (trusted-side orchestration; the command runs in a throwaway container,
  not the agent sandbox). Don't touch `deps.inner`.
- Keep the diff focused — touch only the files named above. Don't import `oneshot/` from `src/blueprints/`.
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — sub-slice 2c / later, confirmed with the user)

- `boundedRetry` combinator and the failure classifier (2c). No retry, no transient/permanent classification,
  no PR-blocking on a failed check.
- Surfacing full check output to the thread or the PR body (capture into `ctx` only).
- Per-repo override maps (a single env-configured override per kind is the knob for this slice).
- The lease-free agentic context view (separate S04b item).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The real tail of `npm run gate` (incl. the vitest pass count).
- Any deviation from this spec and why.
- Anything a unit test can't catch (e.g. that `npm run <kind> --if-present` actually skips a missing script in
  the real runner image is only provable by a live smoke — the coordinator runs it).
