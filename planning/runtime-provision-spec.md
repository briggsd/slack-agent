# Task: add a catalog-gated `provision_runtime` tool that fetches a pinned, relocatable runtime onto the session volume (Python-first)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` and
`runner/CLAUDE.md` first** (gate, two-copy `protocol.ts`, invariants), then the
context below. You are on branch `feat/runtime-provision`.

## Context — read before writing code

- **Design intent:** `design/0012-polyglot-runtimes.md` (the *why* — read it; this slice
  is its "on-demand core"). Track item: `7a984c` (label `sandbox-caps`).
- **The pattern to mirror is `run_checks`, not exec.** `provision_runtime` is gateway-side
  service work that returns a result directly — no session park, no authz gate beyond the
  catalog. Study, in order:
  - `src/oneshot/check-service.ts` (`RealCheckService`) and `src/runner/check-service.ts`
    (the interface) — the service shape to parallel.
  - `src/runner/docker.ts` ~599-650 — how `request_run_checks` is validated and routed to
    the service, then a `run_checks_result` is returned.
  - `src/oneshot/docker-git-node.ts` — `clone()` (272-317), `runCheck()`/`dockerCheckArgs`/
    `dockerCheckEnv` (383-430), and the **named-container + `docker rm -f` on timeout**
    teardown added in `ac96d3` (the `runDocker` `timeoutContainerName` path). Reuse that
    teardown shape for the provision container.
  - `src/oneshot/clone-service.ts` (`RealCloneService`) — the constructor-injected
    allowlist shape (`opts.allowedRepos`); the catalog is injected the same way.
  - `src/config.ts` — `parseRepoAllowlist` / `parseCheckCmds` (pure parse-and-validate,
    fail-startup on malformed) and how `OneShotConfig` is assembled.
  - `runner/src/exec.ts` + `runner/src/main.ts` (exec tool wiring) — the runner-side
    "emit a request line, block on the matching result, return refusal-as-data" helper to
    parallel for the new tool.
- **Motivating need:** a live test (`planning/sandbox-stress-test-retro-2026-06-21.md`,
  PR `briggsd/slack-agent-test#13`) had the agent create a Python file in a Node-only
  sandbox; `run_checks` could not run it, and the agent worked around it by `curl`-ing an
  unpinned binary. This slice makes that safe and first-class.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this run.

## What to build

1. **A pinned runtime catalog.** A pure `parseRuntimeCatalog(raw: string)` in
   `src/config.ts` that parses a JSON map and validates it, **throwing at startup on a
   malformed entry** (like `parseRepoAllowlist`). Shape per entry:
   ```
   "<name>": { "version": string, "url": string, "sha256": string, "binSubdir": string }
   ```
   - `binSubdir` is the path, relative to the extracted root, that holds the executables
     (e.g. `"python/bin"`). Validate: non-empty name; `url` is `https://`; `sha256` is
     64 hex chars; `binSubdir` is a safe relative path (no `..`, no leading `/`).
   - Add `runtimeCatalog: ReadonlyMap<string, RuntimeCatalogEntry>` to `OneShotConfig`.
     Load it in `loadConfig()` from a JSON file whose path is `RUNTIME_CATALOG_PATH`
     (default `config/runtimes.json`); an absent file → empty catalog (feature off). Keep
     the *parse* pure in `config.ts`; do the file read at the `loadConfig` boundary
     (config.ts already owns env→Config) — read the file, pass its contents to
     `parseRuntimeCatalog`. Empty/absent catalog = every `provision_runtime` call is
     refused (fail-closed), exactly like an empty clone allowlist.
   - Commit a real `config/runtimes.json` with **one** entry: `python`, pinned to a real
     `astral-sh/python-build-standalone` **`install_only`** release for **linux-x86_64**
     (the runner image base), with its real `sha256`. (You fetch/verify the checksum; it
     is config data, not exercised by the offline tests.)

2. **`RuntimeProvisionService`** — interface in `src/runner/` (parallel to
   `check-service.ts`) + `RealRuntimeProvisionService` in `src/oneshot/`. Method:
   ```
   provision(req: { name: string; volume: string }): Promise<ProvisionOutcome>
   ```
   where `ProvisionOutcome = { ok: true } | { ok: false; error: string }` (error is short,
   token-free). Behavior:
   - Resolve `name` against the injected catalog. Accept a bare name (`"python"`) → the
     catalog's entry for that name. Not in catalog → `{ ok: false, error: 'runtime not
     available' }` (no fetch).
   - Otherwise delegate to a new `GitNodeExecutor.provisionRuntime(...)` method (extend the
     `GitNodeExecutor` seam in `src/oneshot/docker-git-node.ts` + its interface) that runs
     an **ephemeral, no-credentials** container which: downloads `url`, verifies it against
     `sha256` (mismatch → fail, do not extract), extracts into
     `/workspace/.runtimes/<name>/` on the mounted volume. Idempotent: if
     `/workspace/.runtimes/<name>/<binSubdir>` already exists, return `{ ok: true }`
     without re-downloading.
   - The provision container gets **no `GIT_TOKEN`, no API key** (use `dockerCheckEnv`'s
     no-creds shape). It needs outbound network (default bridge is fine). Bound it with a
     timeout and the **named-container `docker rm -f` teardown** from `ac96d3`.

3. **Protocol pair** — add to **both** `src/runner/protocol.ts` and
   `runner/src/protocol.ts` (byte-identical), modeled on `request_run_checks` /
   `run_checks_result`:
   - `{ type: 'request_provision'; id: string; name: string }`
   - `{ type: 'provision_result'; id: string; ok: boolean; error?: string }`

4. **Gateway wiring** (`src/runner/docker.ts`) — handle `request_provision` the way
   `request_run_checks` is handled: validate `id` and `name` are strings (skip + log a
   malformed line missing `id`, per the defensive-parsing invariant), call
   `RuntimeProvisionService.provision({ name, volume: <this session's volume> })`, and
   write back a `provision_result`. The service is injected into `DockerRunner`/its factory
   the same way the check service is.

5. **Runner-side tool** (`runner/src/`) — expose `mcp__commit__provision_runtime` with a
   single `name` argument. Add a `runner/src/provision.ts` helper that emits
   `request_provision` and resolves on the matching `provision_result` (parallel to
   `runner/src/exec.ts`); parse `provision_result` defensively in the runner's inbound
   dispatcher (`runner/src/approval.ts` parser + `runner/src/main.ts`). The tool returns
   the outcome as text the model reads (success, or the refusal reason — never throws).
   Give the tool a short description telling the model to call it when a needed runtime
   (e.g. `python`) is missing, naming a runtime from the catalog.

6. **`run_checks` finds provisioned runtimes** — in `dockerCheckArgs` (or the check command
   wrapper), prepend any `/workspace/.runtimes/*/bin` directories to `PATH` for the check
   container so a command like `pytest`/`python` resolves. Do it without clobbering the
   base image `PATH` (e.g. wrap the command: `export PATH="$(ls -d /workspace/.runtimes/*/bin
   2>/dev/null | tr '\n' ':')$PATH"; <cmd>`). This must be a no-op when nothing is
   provisioned (existing Node check tests must stay green).

## Acceptance criteria

1. `npm run check` passes — all existing tests keep passing, plus the new ones — and
   `npm run boundaries` is clean. `protocol.ts` is byte-identical across both copies.
2. `parseRuntimeCatalog` returns a validated map for good JSON and **throws** for: bad
   `sha256` length/charset, non-`https` url, a `binSubdir` containing `..` or a leading
   `/`. (Pure unit tests, no I/O.)
3. `RealRuntimeProvisionService.provision` with a name **not** in the catalog returns
   `{ ok: false, error: 'runtime not available' }` and never calls the git-node seam
   (assert via a fake `GitNodeExecutor`). With a name in the catalog it calls
   `provisionRuntime` once with the resolved entry; idempotent re-call (runtime already
   present) returns `{ ok: true }` without a second fetch.
4. The gateway routes `request_provision` → service → `provision_result`: a fake service
   wired into `DockerRunner` yields a `provision_result` with the right `id`/`ok`/`error`;
   a `request_provision` line missing `id` is skipped (logged, not crashed). Mirror the
   existing `run_checks` docker-layer test.
5. The runner-side tool emits `request_provision` and resolves its promise on the matching
   `provision_result`, returning success/refusal text (FakeRunner/parser-level test, like
   the exec tests). An unmatched/garbled `provision_result` is ignored, not thrown.
6. With a runtime present on the volume, the `run_checks` command has
   `/workspace/.runtimes/*/bin` on `PATH`; with none present the check command is
   unchanged (existing check tests unaffected).

## Hard constraints (do NOT violate)

- The gate (`npm run check`) must pass; paste the tail of its output when done.
- Edit **both** `protocol.ts` copies identically.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); inject dependencies, test
  via the existing fakes (`FakeGitNode*`, `FakeRunner`, fake services) — no real Docker,
  network, or filesystem in tests.
- The provision container carries **no credentials**. Treat the catalog `sha256` as the
  integrity gate: a mismatch must fail before any extraction.
- Never log message contents or tokens.
- Add no new runtime dependencies (sha256 via Node's `crypto`; extraction via the
  container's own `tar`/shell, not a node lib).
- Do NOT commit — leave the working tree for review.

## Out of scope (do NOT build — later slices / banked in `0012`)

- **Standard-manifest pre-warm** (reading `pyproject.toml`/`go.mod` at clone time). On-
  demand tool only for this slice.
- Operator per-repo runtime config; shared cross-session runtime cache; extension-based
  guessing; signature verification beyond sha256.
- Any runtime other than the one pinned `python` catalog entry (the mechanism is generic;
  the catalog stays a one-entry file for now).
- Egress restriction of the provision container (sha256 is the v1 floor).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run check` output (real, not paraphrased), and `npm run boundaries`.
- Confirmation the two `protocol.ts` copies are byte-identical (the command you ran).
- Any deviation from this spec and why; anything a unit test can't catch that you
  verified another way (e.g. you cannot exercise a real download offline — say so).
