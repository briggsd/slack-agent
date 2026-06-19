# Task: per-repo lint/test command overrides for one-shot checks (issue #19)

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-m5-oneshot-per-repo-checks`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first** (gate,
invariants, conventions), then the context below. You are on branch
`sonnet/m5-oneshot-per-repo-checks`.

## Context — read before writing code

The one-shot `lint`/`test` deterministic nodes run a check command in an ephemeral, no-credential
`sh` container on the workspace volume. Command resolution today (in
`src/oneshot/docker-git-node.ts` `runCheck`) is: a single **global** override
(`ONESHOT_LINT_CMD` / `ONESHOT_TEST_CMD`, one value for ALL repos) → else npm auto-detect
(`npm run <kind>` guarded by package.json + script-presence; reserved exit `97` = skip).

Issue #19 asks for a **per-repo override** so a multi-repo deployment can configure each repo's
real command. This slice adds **only** that — a repo-slug → {lint,test} command map that wins over
the global override. No new ecosystems, no image change, no install step (those are out of scope,
below).

Code this builds on (read each):
- `src/oneshot/git-node.ts` — `CheckRequest` (currently `{ kind, workdir, volume }` — **no `repo`**)
  and `CheckResult`. Note every OTHER request type here (`CloneRequest`, `PushRequest`, etc.) has a
  required `repo: string`.
- `src/oneshot/docker-git-node.ts` — `DockerGitNodeExecutor`: constructor opts `{ image, spawn?,
  fetchFn?, lintCmd?, testCmd? }`; `runCheck` at ~line 283 resolves `const override = req.kind ===
  'lint' ? this.lintCmd : this.testCmd`. The `override !== undefined` branch means "always ran"
  (a skip is only possible on the npm-auto-detect default — see the `CHECK_SKIP_EXIT` handling).
- `src/oneshot/nodes/lint.ts` and `src/oneshot/nodes/test.ts` — build the `CheckRequest`. They have
  `ctx.repo` in scope (`OneShotContext.repo`).
- `src/config.ts` ~line 94 — the `oneshot` config block reads the env overrides via
  `optionalEnvMaybe('ONESHOT_LINT_CMD')` etc. `optionalEnvMaybe` returns `string | undefined`.
- `src/index.ts` ~line 108 — production wiring: `new DockerGitNodeExecutor({ image, ...lintCmd,
  ...testCmd })` from the config block.
- `src/harness/cli.ts` ~line 69 — harness wiring reads the same env vars directly.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate passes. Make
every edit, add tests, run the gate, fix failures, then stop. Yielding after only exploring (zero
file changes) is a failure — implement end to end in this run.

## Design — resolution precedence (the contract)

For a given `(repo, kind)`, `runCheck` resolves the command in this order:
1. **Per-repo override** — `checkCmds[repo][kind]` if present and non-empty.
2. **Global override** — the existing `lintCmd` / `testCmd` (unchanged behavior).
3. **npm auto-detect** — the existing default (the only branch that can `skipped: true`).

Both override tiers (1 and 2) keep the existing "always ran" semantics: `skipped` is `false`, the
command runs verbatim. Only tier 3 can skip. So the cleanest change is: compute the effective
override as `perRepo ?? global`, then leave the rest of `runCheck` (the `override === undefined`
gate and skip handling) exactly as-is.

### Config shape

New env var **`ONESHOT_CHECK_CMDS`**: a JSON object mapping repo slug → per-kind commands:
```json
{ "acme/api": { "lint": "ruff check", "test": "pytest" }, "acme/web": { "test": "npm test" } }
```
- Each repo entry may set `lint`, `test`, both, or neither. A missing kind for a repo falls through
  to the global override, then auto-detect.
- Parse it in `src/config.ts` into the `oneshot` config block as a typed structure (NOT `any`).
  **Malformed JSON or wrong shape must not crash the gateway** — log nothing sensitive, fall back to
  an empty map (treat as "no per-repo overrides"). Keep parsing defensive and self-contained
  (a small local parse helper is fine).
- Represent the parsed value as `ReadonlyMap<string, { lint?: string; test?: string }>` (or an
  equivalent typed record). The `DockerGitNodeExecutor` constructor gains an optional
  `checkCmds?: ReadonlyMap<string, { lint?: string; test?: string }>`.

### Thread `repo` into `CheckRequest`

`CheckRequest` must carry the repo so the executor can look it up. Add **`repo: string`** (required,
matching the other request types) to `CheckRequest` in `src/oneshot/git-node.ts`, and pass
`repo: ctx.repo` from both `lint.ts` and `test.ts`. Update every existing `runCheck({...})` call
site (the nodes, and the executor tests) to include `repo`. The `FakeGitNodeExecutor` already
records `CheckRequest`s in `checks` — no change needed there beyond the type flowing through.

## Acceptance criteria (numbered, testable)

1. `npm run gate` passes — all existing tests keep passing, plus the new ones below.
2. `CheckRequest` has a required `repo: string`; `lint.ts`/`test.ts` pass `ctx.repo`.
3. `DockerGitNodeExecutor` resolves a per-repo command over the global override over auto-detect,
   per the precedence above. A per-repo command runs verbatim with `skipped: false`.
4. A repo with NO per-repo entry (or a per-repo entry missing that kind) falls back to the global
   override; with neither, to npm auto-detect (the existing shellCmd, unchanged — still skip-capable).
5. `src/config.ts` parses `ONESHOT_CHECK_CMDS`; malformed/empty → empty map, no throw.
6. Both wiring sites (`src/index.ts`, `src/harness/cli.ts`) pass the parsed map to the executor.
7. New tests (see below).

## Tests — front-load these (the failure locus)

Use the EXISTING fakes/patterns — do not invent new harnesses:
- **`test/docker-git-node.test.ts`** — the `DockerGitNodeExecutor — runCheck` describe block
  (~line 551) is your template. It builds the executor with `makeFakeSpawn(...)` and asserts on the
  captured `sh -c <shellCmd>` argv (the `-c` value). Add cases:
  - per-repo override for `repo` `kind` runs that exact command (the captured shellCmd equals it),
    `skipped:false`;
  - per-repo override takes precedence over a configured global `lintCmd`/`testCmd`;
  - a repo NOT in the map falls back to the global override, and (separately) to the npm
    auto-detect shellCmd (assert it contains `npm run <kind>` / `package.json` as the existing tests do);
  - a per-repo entry that sets only `test` leaves `lint` for that repo on the fallback path.
  Update the existing runCheck calls in this file to pass `repo`.
- **`test/oneshot.test.ts`** — assert the lint/test nodes pass `ctx.repo` into the `CheckRequest`
  (the `FakeGitNodeExecutor.checks` array records them; the happy-path orchestrator test uses
  `github:acme/widgets …`, so `checks[i].repo === 'acme/widgets'`).
- **Config parsing** — there is no `test/config.test.ts` today. Rather than introduce `loadConfig`
  env-mutation tests, factor the `ONESHOT_CHECK_CMDS` parse into a small **exported pure function**
  (e.g. `parseCheckCmds(raw: string | undefined): ReadonlyMap<…>`) in `src/config.ts` and unit-test
  it in a new `test/config.test.ts`: valid JSON → populated map; `undefined`/`''`/malformed JSON/
  non-object/wrong-typed values → empty map (no throw). This keeps the gate offline and avoids
  mutating `process.env`.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- **No `any`, no `@ts-ignore`.** The parsed config must be a real type. `exactOptionalPropertyTypes`
  is on — be careful spreading optional fields (mirror the existing `...(x !== undefined ? {x} : {})`
  pattern at the wiring sites).
- ESM `NodeNext` — use `.js` import specifiers.
- Inject external deps in tests (use `makeFakeSpawn` / the existing fakes); no real Docker/network/API.
- Treat the per-repo map as data; a malformed `ONESHOT_CHECK_CMDS` must degrade to "no overrides",
  never crash startup.
- Do NOT touch `protocol.ts` (this change doesn't cross the gateway↔container boundary).
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build)

- New ecosystem auto-detect (Makefile/Go/Python/CI-config) — separate slice; the image can't run
  them anyway.
- A dependency-install step before checks.
- Any Dockerfile change.
- Changing the global-override or npm-auto-detect behavior beyond inserting the per-repo tier ahead
  of it.

## Report back

Summarize what changed (file by file), paste the **gate output tail** (with the test count), and
note any place the real types forced a deviation from this spec.
