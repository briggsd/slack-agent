# Task: Clone during the conversation + use the session volume for SPEC.md (router S11)

You are implementing one slice in this worktree
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first** (gate, invariants, conventions) and `runner/CLAUDE.md` (the two-copy
`protocol.ts` rule, ground SDK calls in the `.d.ts`). You are on branch
`sonnet/m6-s11-clone-volume`.

This is S11 of the conversational-planning (router) arc. S10 shipped the commit
spine: the in-container `submit_spec` tool emits `request_approval`, the gateway
parks via `awaitApproval`, and a verdict flows back into the parked tool. S11 gives
the router a **real tree to reason over** and a **durable place for the spec**, both
on the session volume — with the clone credential never touching the agent.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run `npm run gate`, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure. Do NOT edit this
spec file.

## CRITICAL — ground API usage, don't recall it

Before touching `runner/src/main.ts`, read
`runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for `tool()` /
`createSdkMcpServer()` and the zod input shape — model the `clone_repo` tool on the
existing `submit_spec` tool (`runner/src/main.ts:563-591`), which is already verified
against that `.d.ts`. Use only symbols you can point to. If the real API differs,
follow it and note the difference in your report.

## Context — read before writing code

- The *why* lives in `design/0007` (gitignored — NOT in this worktree). The decisions
  you need are inlined here; do not go looking for it.
- Two product decisions locked with the user (2026-06-20), already reflected below:
  - **The runner reads the file.** The agent writes `/workspace/SPEC.md`;
    `submit_spec` reads that file *inside the container* and sends its content as the
    approval `specRef`. No gateway→volume read is built. `specRef` stays text-typed —
    the **only** new protocol is the clone request/result pair.
  - **Investigation-only is soft for S11.** System-prompt guidance + the structural
    guarantee that the conversational session holds no write credential. A hard,
    path-scoped tool restriction is banked as its own slice — do NOT build it.

- Code this builds on (read these):
  - `src/runner/docker.ts` — `DockerRunner` (one container per session; already mounts
    `slackbot-ws-<key>:/workspace` at line 577) and its `send()` line loop, which
    already services `request_approval` mid-turn (lines 390-417). The clone is serviced
    the same way, **inline in `send()`**, but with no human hop. Note the existing
    `sanitizeKey` / `volumeNameFor` helpers (lines 96-103).
  - `runner/src/main.ts` — the runner loop, the stdin demux dispatcher (lines 170-193),
    `buildCommitMcpServer` (the `submit_spec` tool, lines 563-591), `realReadFile`
    (lines 486-494), and the two system-prompt additions (lines 97-111).
  - `runner/src/approval.ts` — `ApprovalCoordinator` + `parseInbound`. The clone
    coordinator mirrors `ApprovalCoordinator`; `parseInbound`'s `InboundParsed` union
    and parser grow a `clone_result` case.
  - `src/oneshot/git-node.ts` / `docker-git-node.ts` — `GitNodeExecutor.clone()` runs an
    ephemeral `docker run --rm --entrypoint git` with the token in ENV via an inline
    credential helper; the tree lands on the mounted volume. Token never in argv/URL/log.
  - `src/oneshot/orchestrator.ts` — how the one-shot path mints a read lease
    (`broker.lease({host, repo, taskId})`, line 69), derives `workdir =
    /workspace/<slug>` via `repo.replaceAll('/', '-')` (line 62-63), runs `gitNodes.clone`,
    and revokes the lease in a `finally` (lines 79-124). The router clone reuses this recipe.
  - `src/oneshot/dispatching-factory.ts` — already holds `broker` + `gitNodes`; the
    conversational branch (line 42) currently just delegates to the base factory.
  - `src/broker/{types,fake}.ts` — `CredentialBroker.lease` → `CredentialLease{token,
    host, repo, revoke()}`. `FakeBroker` for tests. `src/oneshot/fake-git-node.ts` —
    `FakeGitNodeExecutor` records every `clone()` call in `.clones`.
  - `src/index.ts` — wiring root: constructs `broker` + `gitNodes` (real or fake), the
    `DockerRunnerFactory`, and the `DispatchingRunnerFactory` (lines ~87-132).

## Invariants (boundary-enforced — `npm run boundaries` fails the build if broken)

- **`protocol.ts` is two byte-identical copies** — `src/runner/protocol.ts` ≡
  `runner/src/protocol.ts`. Edit BOTH in the same change; verify with
  `diff src/runner/protocol.ts runner/src/protocol.ts` (must print nothing).
- **The gateway never imports the `runner/` package or the Agent SDK.** The container
  is the permission boundary.
- **No circular deps.** `src/oneshot/*` already imports `volumeNameFor` from
  `src/runner/docker.ts` (arrow: oneshot → runner). Do NOT create the reverse — see the
  dependency-direction rule below, it is the crux of the wiring.
- **Never log message contents or tokens** — ids/sizes/lifecycle only.
- No `any`, no `@ts-ignore`. `NodeNext` ESM (`.js` import specifiers).
  `exactOptionalPropertyTypes` is on — set optional fields only when present.

## The clone seam (this is the heart of the slice)

The agent cannot run the clone itself — the credential must never enter the agent env.
So a clone is a gateway service the agent *requests*, mirroring the S10 commit gate,
minus the human:

```
agent (router): clone_repo({ repo: "owner/name" })          // in-container SDK tool
runner → gw:    request_clone{ id, repo }                    // NEW protocol line
gateway:        mint READ lease → gitNodes.clone(            // token in ephemeral git
                  { lease, repo, volume, workdir:/workspace/<slug>, shallow:true }) //  container only
                → revoke lease
gw → runner:    clone_result{ id, ok, workdir?, error? }     // NEW protocol line
runner:         clone_repo tool returns the local path (or the error) to the model
```

The tree lands on the session volume; the agent reads it with `Grep`/`Glob`/`Read` at
the returned path. No park, no manager involvement, no human — the gateway services it
inline in `DockerRunner.send()` and answers immediately.

### Dependency direction (respect it or `boundaries` fails)

- **Interface in `src/runner/`** — define `CloneService` + its request/outcome types in a
  new `src/runner/clone-service.ts`. `docker.ts` imports the interface from within
  `src/runner` (no cycle):
  ```ts
  // src/runner/clone-service.ts
  export interface CloneServiceRequest { repo: string; volume: string; }
  export type CloneOutcome =
    | { ok: true; workdir: string }
    | { ok: false; error: string };
  export interface CloneService { clone(req: CloneServiceRequest): Promise<CloneOutcome>; }
  ```
- **Implementation in `src/oneshot/`** — `RealCloneService` in a new
  `src/oneshot/clone-service.ts`, closing over `broker` + `gitNodes`, importing the
  interface from `src/runner` (same direction as today's `volumeNameFor` import).
  `clone()`: host defaults to `'github'` (the only configured host; do NOT add a host
  arg to the protocol — multi-host is banked). Mint a `taskId` (correlation-id style, as
  `orchestrator.ts:40`), derive `workdir = /workspace/${repo.replaceAll('/', '-')}`,
  `await gitNodes.clone({ lease, repo, workdir, volume, shallow: true })`, revoke the
  lease in a `finally`, return `{ ok:true, workdir }`. On a thrown clone/lease error,
  return `{ ok:false, error: <message> }` (the message from `gitNodes.clone` is already
  token-free) and still revoke. **Never throw out of `clone()`** — the outcome is data.
- **`FakeCloneService`** — put it in `src/runner/` (so `docker.ts` tests use it without
  importing oneshot). Records `clone()` calls; scriptable to return ok or failure.

### Wiring (keep `boundaries` green)

`DockerRunnerFactory` gains an optional ctor field `cloneService?: CloneService`. When it
creates a `DockerRunner`, it passes the service plus that session's
`volumeNameFor(sessionKey)` into the runner. `DockerRunner` gains optional
`cloneService` + `volume` fields; when `cloneService` is absent (the fake-runner path),
a `request_clone` is answered `clone_result{ ok:false, error:'clone unavailable' }` so
the tool always unblocks. In `src/index.ts`, build a `RealCloneService(broker, gitNodes)`
(both already constructed there) and inject it into the `DockerRunnerFactory`.
`DispatchingRunnerFactory` needs no change.

## Protocol additions (edit BOTH copies identically)

- **Runner → gateway** — add to `RunnerToGatewayMessage`:
  ```ts
  export type RequestCloneMessage = {
    type: 'request_clone';
    id: string;    // the runner's own clone-correlation id (distinct from the turn id)
    repo: string;  // "owner/name"
  };
  ```
- **Gateway → runner** — add to `GatewayToRunnerMessage`:
  ```ts
  export type CloneResultMessage = {
    type: 'clone_result';
    id: string;
    ok: boolean;
    workdir?: string; // present iff ok — the path the tree landed at
    error?: string;   // present iff !ok — a short, token-free reason
  };
  ```
  (`exactOptionalPropertyTypes` is on — set `workdir`/`error` only when present, the way
  `ApprovalVerdictMessage.feedback` is handled.) Document each new type with a one-block
  comment, matching the style of the existing message docs.

## Container side (`runner/`)

- **`CloneCoordinator`** (new `runner/src/clone.ts`, modelled on `ApprovalCoordinator`):
  `requestClone(repo)` mints an id (`clone-${++seq}`), emits `request_clone`, parks on a
  promise; `handleResult(msg)` resolves it with the `CloneOutcome`; unknown/settled id →
  ignored (returns false); `failAllPending()` resolves any in-flight clone as
  `{ ok:false, error:'shutting down' }` on stdin close, and a post-drain `requestClone`
  resolves immediately (same drain guard `ApprovalCoordinator` uses).
- **`parseInbound`** (`runner/src/approval.ts`): add a `clone_result` case to the
  `InboundParsed` union and the parser (validate `id: string`, `ok: boolean`, optional
  string `workdir`/`error`; bad shape → `kind:'bad'`).
- **Dispatcher** (`runner/src/main.ts:170-193`): route a parsed `clone_result` line to the
  clone coordinator's `handleResult`, exactly as `approval_verdict` routes to the approval
  coordinator. Construct the `CloneCoordinator` next to the `ApprovalCoordinator`, and
  thread a `cloneRepo: (repo) => Promise<CloneOutcome>` into `processTurn`/`sdkQuery`
  beside `submitSpec`. Route `failAllPending` on `rl.close` for the clone coordinator too.
- **`clone_repo` tool** (extend `buildCommitMcpServer` or add a sibling MCP server; keep
  `alwaysLoad: true`): input `{ repo: z.string() }`; handler calls `cloneRepo(repo)` and
  returns the local `workdir` on success or the error text on failure as a tool result.
  Wrap any failure text as data, not instructions (same discipline as gate feedback).
- **`submit_spec` now reads the file.** Change the tool to read `/workspace/SPEC.md`
  inside the container (thread the existing `readFile` seam — `ReadFileFn` — into the tool
  builder) and pass its content as the approval `specRef`; **drop the inline `spec`
  argument**. If the file is missing or empty, return a tool result telling the agent to
  write `/workspace/SPEC.md` first (do NOT raise the gate). Keep the file-read in a small
  exported helper (e.g. `readSpecForApproval(readFile)`) so it has unit coverage without
  the real SDK — the existing `runner-main` seam injects `submitSpec` directly and bypasses
  the tool handler.
- **System prompt**: add a router/clone addition telling the agent: to investigate a repo,
  call `clone_repo` with `owner/name`; it returns the local path; read the tree there;
  write the spec to `/workspace/SPEC.md`; it is **investigation-only** — do not edit the
  cloned tree, write only `/workspace/SPEC.md`; when ready, call `submit_spec` (which reads
  that file). Update `COMMIT_SYSTEM_PROMPT_ADDITION` so it no longer implies an inline spec
  argument.

## Gateway side (`src/runner/docker.ts`)

In `send()`, add a `request_clone` branch beside the `request_approval` one:

- Validate the line as data. If `id` is a string but `repo` is not, you still have a usable
  id → answer `clone_result{ id, ok:false, error:'malformed request' }` so the parked tool
  unblocks. If `id` is not a string, skip (uncorrelatable) with a one-line log.
- Yield a `status` RunnerEvent (e.g. `cloning owner/name…`) for user-visible progress,
  then `await self.cloneService.clone({ repo, volume })` (or the `clone unavailable`
  outcome when no service is wired), and write the `clone_result` line. Same stdin-writable
  guard as the verdict path (lines 408-411): if stdin is gone, yield an `error` and return
  rather than dropping the result.
- The clone counts against the turn deadline (it is bounded, unlike the human gate — do NOT
  reset `deadline`). Shallow clone keeps it fast.

**Carry-forward fix (parked on this item, from the S10a factory review).** While in
`send()`, make malformed-control-line handling *unblock the parked tool whenever it can
correlate*, instead of silently `continue`-skipping and stranding it. Currently the
`request_approval` branch (line 395-397) does `continue` when `specRef` is malformed. Change
it so: when `id` is a usable string but `specRef` is malformed, answer
`approval_verdict{ id, approved:false }` (mirror the new `request_clone` treatment); only
skip when there is no usable `id`, with a one-line log. This aligns both gates with "the
router never abandons — the parked tool always unblocks."

## Shallow clone (low-risk, optional field)

Add an optional `shallow?: boolean` to `CloneRequest` (`src/oneshot/git-node.ts`).
`DockerGitNodeExecutor.clone` appends `--depth 1 --single-branch` to the git args only when
`shallow` is set (insert into the `gitArgs` array before `cloneUrl`). `RealCloneService`
sets `shallow: true`. The one-shot `cloneNode` (`src/oneshot/nodes/clone.ts`) is unchanged
(full clone — do not pass `shallow`). There is no push in S11, so shallow-vs-push is out of
scope.

## Acceptance criteria

1. `npm run gate` passes (`tsc` + runner `tsc` + `vitest` + `boundaries`). Paste the real
   tail. No new circular-dependency or layering violations.
2. **Clone round-trip through the fakes.** A `DockerRunner` (real class, `FakeChildProcess`)
   given a `request_clone` line and a `FakeCloneService`: yields a `status` event, services
   the clone, writes a `clone_result` line; the recorded `CloneService` call carries the
   right `repo` + `volume`. Success → `clone_result{ ok:true, workdir }`; a `FakeCloneService`
   failure → `clone_result{ ok:false, error }`; no `cloneService` wired → `clone unavailable`.
   A malformed `request_clone` with a usable `id` → `clone_result{ ok:false }` (tool
   unblocks), not a silent skip.
3. **`RealCloneService` reuses the credential recipe.** With `FakeBroker` +
   `FakeGitNodeExecutor`: leases `{host:'github', repo, taskId}`, calls `gitNodes.clone` with
   `workdir:/workspace/<slug>` + the passed `volume` + `shallow:true`, revokes the lease, and
   returns `{ ok:true, workdir }`. On a thrown `gitNodes.clone`, returns `{ ok:false, error }`
   and still revokes.
4. **Container side**: `CloneCoordinator` unit tests (emit+park, `handleResult` resolves,
   unknown id ignored, drain fails pending / post-drain resolves immediately); `parseInbound`
   accepts a well-formed `clone_result` and rejects malformed; the stdin dispatcher routes
   `clone_result` to the clone coordinator.
5. **`submit_spec` reads `/workspace/SPEC.md`**: a unit test on the file-read helper shows
   content present → that content becomes the `specRef`; missing/empty → the agent-facing
   "write SPEC.md first" result and no gate raised.
6. **Protocol**: `diff src/runner/protocol.ts runner/src/protocol.ts` prints nothing; the two
   new message types are in both copies with docs.

## Hard constraints (do NOT violate)

- The gate must pass; paste the real tail of `npm run gate` (with pass/fail counts).
- No `any`, no `@ts-ignore`; `NodeNext` ESM; `exactOptionalPropertyTypes` honoured on the new
  optional fields.
- **The credential never enters the agent env.** The clone runs only via the existing
  `gitNodes.clone` ephemeral-container path; the gateway services `request_clone`. Never pass
  a token, lease, or broker into the `runner/` package.
- Treat every line from the container as data — validate shape, never execute; malformed lines
  are handled, not crashed on.
- Never log message contents or tokens.
- Edit both `protocol.ts` copies identically.
- Add no dependencies. Tests stay offline (no Slack/Docker/API/network) via the existing fakes.
- Stage explicit paths (`git status` first) — never `git add -A`/`.`. Do NOT commit; leave the
  tree for the coordinator to review. Do NOT touch this spec file.

## Out of scope (do NOT build)

- Dispatching the build tail / fresh implementer container — S12.
- Hard, path-scoped investigation-only tool restriction — banked.
- A gateway→volume file read; multi-host clone; a `host` protocol field — banked.
- Planning-session reaper exemption / planning-idle-timeout — S13.
- Block Kit commit button; spend pre-dispatch check — S15 / banked.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real, not paraphrased), including the `boundaries` step and the
  vitest pass/fail counts.
- Confirm `diff src/runner/protocol.ts runner/src/protocol.ts` prints nothing.
- Any deviation from this spec and why.
- What a unit test can't catch (the real clone + volume round-trip is not exercised by the
  offline gate) — flag it for the coordinator's `smoke-docker` / `smoke-commit-gate` pass.
