# 0010 S03 - Coordinator Run Checks Tool

## Goal

Give the coordinator its independent check surface after a local build candidate is produced. Add a gateway-serviced `run_checks` tool that the runner can call from inside the coordinator turn. The gateway must run the existing deterministic project checks on the shared volume and return raw check output to the coordinator as data.

This implements the `201cec` spine item from `design/0010-coordinator-verifies.md`. It is the check half of the coordinator's "eyes"; diff inspection can use the existing SDK file/Bash access in `/workspace` for this slice.

## Current Grounding

The first two 0010 slices are already on `main`:

- PR #47 added `publish` / `open_pr`.
- PR #48 made `build-tail` local-only and build success candidate-ready.

Relevant current shapes:

- `src/runner/protocol.ts:20-25` has gateway-to-runner messages: user, approval, clone, build, publish. Add a run-checks result here and mirror it byte-identically in `runner/src/protocol.ts`.
- `src/runner/protocol.ts:102-112` has runner-to-gateway messages: ready/status/file/text/usage/request approval/clone/build/publish/error. Add a run-checks request here and mirror it.
- `src/oneshot/git-node.ts:59-69` defines `CheckResult = { exitCode, output, skipped }`.
- `src/oneshot/git-node.ts:72-105` defines `CheckRequest` and `GitNodeExecutor.runCheck`; non-zero exit is data, not an exception, and checks get no credential.
- `src/oneshot/docker-git-node.ts:336-365` implements `runCheck` using the existing git/check container and per-repo/global/default command resolution.
- `runner/src/approval.ts:86-93` has the inbound parser result union; add run-checks result routing there.
- `runner/src/approval.ts:146-180` parses `build_result` and `publish_result`; add strict parsing for `run_checks_result` and validate nested result shape.
- `runner/src/build.ts`, `runner/src/clone.ts`, and `runner/src/publish.ts` are the model for a pure container-side coordinator class.
- `runner/src/main.ts:251-280` constructs approval/clone/build/publish coordinators and emits `request_*` lines.
- `runner/src/main.ts:303-337` demuxes inbound results; add `run_checks_result`.
- `runner/src/main.ts:339-345` fails pending tools on stdin close; include run-checks.
- `runner/src/main.ts:734-800` builds the commit MCP server and currently exposes `build_spec`, `clone_repo`, `publish`, and `open_pr`. Add `run_checks` to that server.
- `runner/src/main.ts:420-429` sets SDK `cwd` to `/workspace` and allows normal SDK tools, so the coordinator can inspect diffs with existing file/Bash tools after build. Do not build a custom diff protocol in this slice.
- `src/runner/docker.ts:533-586` services `request_publish` inline through a service seam and resets the turn deadline. `request_run_checks` should follow that shape.
- `src/runner/docker.ts:657-672` and `src/runner/docker.ts:769-772` pass clone/publish services through `DockerRunnerFactory` into `DockerRunner`; add run-checks wiring the same way.
- `src/index.ts:22-23` and `src/index.ts:110-121` wire real clone/publish services. Add the real run-checks service there, reusing the same `gitNodes`.
- Tests to mirror: `test/docker-publish.test.ts`, `runner/test/publish.test.ts`, `runner/test/publish-tool.test.ts`, `runner/test/approval.test.ts`, plus service tests like `test/publish-service.test.ts`.

## Required Behavior

### Protocol

Add these message concepts to both protocol copies:

- `RequestRunChecksMessage`
  - `type: "request_run_checks"`
  - `id: string`
  - `repo: string`
  - `kind?: "lint" | "test" | "all"`
- `RunChecksResultMessage`
  - `type: "run_checks_result"`
  - `id: string`
  - `ok: boolean`
  - on success, `results` is an array of per-check results:
    - `kind: "lint" | "test"`
    - `exitCode: number`
    - `skipped: boolean`
    - `output: string`
  - on failure, `reason?: string`

`kind` defaults to `"all"` if omitted. `"all"` runs lint then test in that order. `ok` means the gateway successfully ran the requested check command(s), not that the checks passed. A failed lint/test process still returns `ok: true` with a non-zero `exitCode`; only malformed input, invalid repo/kind, missing service/volume, or infrastructure exceptions return `ok: false`.

Keep `src/runner/protocol.ts` and `runner/src/protocol.ts` byte-identical.

### Gateway Service

Add a gateway-side service seam under `src/runner/`, likely `check-service.ts`, with:

- request `{ repo, volume, kind?: "lint" | "test" | "all" }`
- outcome `{ ok: true; results: CheckResultWithKind[] } | { ok: false; reason: string }`
- no credential data

Add a real implementation under `src/oneshot/`, likely `check-service.ts`, that:

- validates repo as strict `owner/name`, matching `RealPublishService`;
- derives `workdir` with `workdirForRepo(repo)`;
- verifies repo binding with `gitNodes.verifyRepo({ repo, workdir, volume })` before running checks;
- runs `gitNodes.runCheck({ kind, repo, workdir, volume })`;
- for `"all"`, runs lint then test and returns both results;
- catches true infrastructure exceptions and returns short `reason` strings, not stack traces;
- never mints a broker lease and never logs content or check output.

Add a fake service for DockerRunner tests, like `FakePublishService`.

### DockerRunner Relay

In `src/runner/docker.ts`, add an inline branch for `request_run_checks`:

- validate `id`, `repo`, and optional `kind`;
- return `run_checks_result { ok:false, reason:"malformed request" }` on malformed requests where `id` is usable;
- yield a status like `running checks for <repo>...` without logging output;
- call the wired run-checks service if available and `volume` exists, else return `ok:false` / `run_checks unavailable`;
- write `run_checks_result` back to the container;
- reset the turn deadline after servicing, same as clone/build/publish.

Wire the service through `DockerRunner` and `DockerRunnerFactory`, and through real startup/harness wiring.

### Runner Tool

Add a container-side coordinator, likely `runner/src/checks.ts`, mirroring `BuildCoordinator` / `PublishCoordinator`:

- emits `request_run_checks`;
- tracks pending ids such as `checks-1`;
- handles `run_checks_result`;
- fails pending requests on stdin close with `{ ok:false, reason:"shutting down" }`.

Expose `run_checks` in the commit MCP server:

- schema: `repo: string`, `kind?: "lint" | "test" | "all"`;
- default kind to `"all"`;
- return readable text containing each check's kind, exit code, skipped flag, and raw output in clear delimiters.

Update prompt text so after `build_spec` returns candidate-ready, the coordinator is told to inspect the diff using the normal workspace tools and call `run_checks` before `publish` / `open_pr`.

### Diff Surface

Do not add a bespoke diff protocol in this slice. The SDK already runs with `cwd: /workspace` (`runner/src/main.ts:420`) and can use normal file/Bash tools. The prompt should explicitly tell the coordinator to inspect the cloned repo worktree after `build_spec`, for example with `git -C /workspace/<owner-name> diff main...HEAD` or equivalent. Keep this as guidance only.

## Tests

Add or update focused offline tests:

- Protocol parser:
  - accepts `run_checks_result` success with lint/test results and raw output;
  - accepts `ok:false` with reason;
  - rejects malformed result shape.
- Runner coordinator/tool:
  - emits `request_run_checks` with repo and default/all kind;
  - maps result success/failure;
  - ignores unknown ids;
  - fails pending requests on shutdown;
  - `run_checks` tool text includes raw output and skipped/exit metadata.
- DockerRunner relay:
  - `request_run_checks` yields status, calls fake service with repo/volume/kind, writes `run_checks_result`;
  - omitted kind defaults to all;
  - malformed repo/kind returns malformed request and does not call service;
  - no service/volume returns unavailable.
- Real service:
  - validates repo shape;
  - verifies repo binding before checks;
  - all-kind runs lint then test in order;
  - non-zero check exit returns `ok:true`;
  - thrown `runCheck` returns `ok:false` with short reason;
  - no broker lease is minted (service should not depend on a broker at all).
- Existing clone/build/publish tests still pass.

## Acceptance Criteria

- `npm run gate` passes.
- `diff src/runner/protocol.ts runner/src/protocol.ts` is empty.
- The new tool returns raw output as data but no check output is logged by gateway/runner.
- `run_checks` does not mint credentials and does not push/open a PR.
- `publish` / `open_pr` behavior remains unchanged.

## Out Of Scope

- Full verify-then-publish coordinator prompt/skill loop from `eac5a0`.
- Automatic rebuild/iterate behavior.
- End-turn-and-resume UX.
- A custom read-diff protocol or diff summarizer.
- Live Docker/API smoke tests.

## Constraints

- No new dependencies.
- No `any` or `ts-ignore`.
- Keep the protocol copies byte-identical.
- Keep tests offline.
- Treat all container lines as data.
- Do not log message contents, check output, tokens, or credentials.
- Do not remove the `node_modules` or `runner/node_modules` symlinks in this worktree.
- Do not modify this spec as part of implementation.
