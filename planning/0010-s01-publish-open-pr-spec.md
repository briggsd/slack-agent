# Task: Add the gated `publish` / `open_pr` tool path

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-0010-publish-open-pr`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first** (gate, invariants, conventions), then the context below. You are on branch
`sonnet/0010-publish-open-pr`.

## Context - read before writing code

- Design intent: `design/0010-coordinator-verifies.md` decided that S12's build tail
  currently opens a PR too early. In the new model, the build produces a local
  candidate; the coordinator verifies it; only then does it call a gateway-serviced
  publish tool. This slice adds that publish path before later slices remove
  push/open-pr from `build-tail`.
- This is track `7b2169`, and it folds in the target-authorization concern from
  `d169c3`: the publish target must be bound to the verified clone on the session's
  shared volume. Do not introduce gateway-side "last clone" tracking; derive the
  workdir from the approved `repo` exactly as clone/build already do.
- Existing protocol shape: `src/runner/protocol.ts:20-77` defines gateway->runner
  result messages, and `src/runner/protocol.ts:81-187` defines runner->gateway
  request messages. **There are two byte-identical copies**:
  `src/runner/protocol.ts` and `runner/src/protocol.ts`.
- Existing gateway relay precedent: `src/runner/docker.ts:446-495` validates
  `request_clone`, services it via a gateway service seam, writes `clone_result`,
  and resets the turn deadline; `src/runner/docker.ts:496-526` validates
  `request_build`, yields to the manager, writes `build_result`, and resets the
  turn deadline.
- Existing container coordinator precedent: `runner/src/build.ts:24-73` is the pure
  request/result coordinator shape. `runner/src/approval.ts:80-158` parses inbound
  result lines defensively. `runner/src/main.ts:212-228` wires coordinators,
  `runner/src/main.ts:251-280` dispatches inbound results, and
  `runner/src/main.ts:350-367` passes tool callbacks/system prompt to the SDK.
- Existing SDK tool seam: `runner/src/main.ts:51-89` defines `SdkQueryFn` with
  callbacks used by fake tests and by the real `createSdkMcpServer` query wrapper.
  Before adding the real MCP tool, read
  `runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`; existing comments
  at `runner/src/main.ts:361-362` show this is the source of truth.
- Existing publish operations: `src/oneshot/nodes/push.ts:1-14` calls
  `gitNodes.push`; `src/oneshot/nodes/open-pr.ts:1-54` composes the PR title/body
  and calls `gitNodes.openChangeRequest`; `src/oneshot/git-node.ts:25-39` defines
  the request shapes. Reuse that logic by extracting helpers where useful; do not
  duplicate title/body behavior by hand.
- Existing credentialed service precedent: `src/runner/clone-service.ts:1-20`
  defines the runner-side service seam, `src/oneshot/clone-service.ts:24-62` mints
  a lease, runs a git node operation, revokes in `finally`, validates repo slugs,
  and returns failures as data.
- Existing build tail still includes push/open-pr at
  `src/oneshot/build-tail.ts:7-10`. Leave that unchanged in this slice.

## CRITICAL - do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure - implement end to
end in this run.

## CRITICAL - ground API usage, don't recall it

Read the relevant `@anthropic-ai/claude-agent-sdk` `.d.ts` before writing or
changing the real SDK MCP tool wiring. Use only symbols you can point to. If the
real API differs from what you expected, follow the real API and note the
difference in your report.

## Acceptance criteria

1. `npm run gate` passes, including root tsc, runner tsc, vitest, and dependency
   boundaries. Also run `diff src/runner/protocol.ts runner/src/protocol.ts` and
   ensure it prints nothing.
2. Add a new protocol pair in both protocol copies:
   - runner -> gateway: `request_publish` with `id`, `repo`, optional `title`, and
     optional `body`.
   - gateway -> runner: `publish_result` with `id`, `ok`, optional `prUrl`, and
     optional `reason`.
   The result should be included in `GatewayToRunnerMessage`; the request should be
   included in `RunnerToGatewayMessage`.
3. Add a container-side `PublishCoordinator` mirroring `BuildCoordinator`:
   `requestPublish(input)` emits `request_publish` with ids like `publish-1`, parks
   until the matching `publish_result`, returns `{ ok: true, prUrl }` or
   `{ ok: false, reason }`, ignores unknown ids, and resolves pending/new requests
   as failed on stdin close.
4. Extend `runner/src/approval.ts` parsing so `publish_result` is accepted
   defensively and routed by `runner/src/main.ts` to the `PublishCoordinator`.
5. Add a real SDK tool named `publish` (tool full name will be
   `mcp__commit__publish`) and preferably expose an alias `open_pr` if that is a
   small, low-risk addition in the same MCP server. The tool must call the
   `PublishCoordinator`; it must not shell out, push, call GitHub, or see tokens.
   Its user-facing result text should say whether publishing opened a PR and return
   the PR URL or the short failure reason.
6. Add a gateway-side `PublishService` seam in `src/runner/` plus real/fake
   implementations following `CloneService`:
   - `PublishService.publish({ repo, volume, title?, body? })`
   - validate repo as strict `owner/name`, derive `workdir` as
     `/workspace/${repo.replaceAll('/', '-')}`, and derive a branch that matches
     the build tail's branch convention for the current task/session. If a helper
     must be extracted from `OneShotOrchestrator` to avoid drift, do that.
   - mint a write lease through the broker, call `gitNodes.push`, then
     `gitNodes.openChangeRequest`, revoke the lease in `finally`, and return
     failures as data.
   - The PR title/body must come from the coordinator-provided optional title/body
     when non-empty, otherwise use a conservative fallback. Do not rely on model
     text for safety-critical routing; the repo/workdir/volume binding comes from
     gateway derivation.
7. Wire `PublishService` into `DockerRunner`/`DockerRunnerFactory` the way
   `CloneService` is wired. A well-formed `request_publish` should yield a short
   status like `publishing owner/repo...`, call the service with the session volume,
   write `publish_result`, and reset the turn deadline. Malformed-with-id should
   write `publish_result { ok:false, reason:'malformed request' }` and not call the
   service. Missing id should be logged/skipped.
8. Update `src/index.ts` and the harness wiring so the real app passes both
   `RealCloneService` and `RealPublishService` into the Docker runner factory.
9. Tests:
   - runner unit tests for `PublishCoordinator`, including ok, failure, unknown id,
     drained behavior, and concurrent request correlation.
   - `parseInbound` tests for valid/invalid `publish_result`.
   - helper/tool tests in `runner/test` proving `runPublish` (or equivalent) calls
     the callback and returns the expected text for ok/failure.
   - gateway Docker relay tests mirroring `test/docker-clone.test.ts`: success,
     failure, unavailable service, malformed-with-id, and no service call on
     malformed input.
   - service tests for `RealPublishService` using `FakeBroker` and
     `FakeGitNodeExecutor`: invalid repo rejects before lease; happy path leases,
     pushes, opens a PR, revokes; push/open failures return `{ ok:false }` and
     revoke; arguments bind `repo`, `workdir`, and `volume` correctly.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the tail of its output when done.
- Conventions per root `CLAUDE.md`: no `any`, no `@ts-ignore`; `NodeNext` ESM;
  inject external dependencies; no new dependencies.
- If touching `protocol.ts`, edit **both** copies identically
  (`src/runner/protocol.ts` == `runner/src/protocol.ts`).
- Never log message contents, spec contents, PR body contents, or tokens. Logs may
  name repo slugs, session keys, lifecycle events, and error summaries.
- The gateway never runs agent code. The container never receives credentials.
- Treat all container protocol lines as data: validate shapes; malformed lines must
  unblock parked tools where possible, not crash the gateway.
- Do not alter the existing S12 `request_build`/`build_result` behavior or remove
  push/open-pr from `build-tail`; that belongs to the next slice.
- Do NOT commit implementation changes; leave them unstaged for coordinator review.

## Out of scope (do NOT build)

- Splitting `build-tail` to local-only (`65ce66`).
- `run_checks` and read-the-diff surfaces (`201cec`, `ebb2c1`).
- Coordinator verify-then-publish prompt/UX (`eac5a0`), beyond a minimal mention
  that `publish` exists.
- End-turn-and-resume human asks (`95dd82`).
- Live Docker/API smoke. Keep the offline test suite deterministic.

## When done - report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased).
- The output of `diff src/runner/protocol.ts runner/src/protocol.ts` (should be empty).
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
