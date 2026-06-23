# The toolshed — how the agent's tools work, and how to add one

The agent inside each container reaches the outside world through a small set of tools.
This is the guide to that set: what the two kinds of tool are, how a privileged tool's
round trip works, and the exact steps to add a new one. Read it before you wire a tool;
the wiring spans five files and the halves drift if you skip one.

The *why* and the planned registry live in `design/0018-tool-registry.md` (gitignored).
This file is the as-built map. For the surrounding system, see `docs/ARCHITECTURE.md`.

## Two kinds of tool

| Kind | Where it runs | Reaches | How you add it |
|---|---|---|---|
| **In-container SDK tool** | Inside the sandbox, by the Agent SDK | The container's own filesystem and shell (`/workspace`) | Nothing to do here. `bash`, file edits, and the rest ship with the Agent SDK and run with full access *inside* the throwaway container. |
| **Gateway-serviced tool** | The tool *call* runs in the container; the *work* runs in the gateway | The host, the network, GitHub, and credentials | The rest of this doc. The container asks over the protocol; the gateway does the privileged part and answers. |

The split is the security boundary. The gateway holds the GitHub token, the Docker socket,
and host access; the container holds none of those and never sees them. So any tool that
needs a credential or host reach is gateway-serviced. A tool that only touches files in
`/workspace` belongs to the SDK and needs no wiring from us.

The current gateway-serviced tools: `clone_repo`, `build_spec`, `exec`, `run_checks`,
`provision_runtime`, `publish` (aliased as `open_pr`), `edit_pr`, and `comment_pr`. There
is also `report_verification`, which is one-way (it records a decision and expects no
answer; see `kind:'decision'` in the audit ledger).

## The round trip

A gateway-serviced tool is a request the container sends and a result it waits for, both
single NDJSON lines over the container's stdin/stdout. `comment_pr` is the cleanest worked
example (PR #67). Trace it:

```
 container (runner/)                          gateway (src/)
 ─────────────────                            ─────────────
 agent calls comment_pr(repo, comment)
        │
        ▼
 tool handler → CommentPrCoordinator
   .requestCommentPr()
        │  emits one line:
        │  {type:'request_pr_comment', id:'pr-comment-1', repo, comment}
        └──────────────  stdout  ──────────────►  docker.ts read loop
                                                    validates the line as data
                                                    calls publishService.commentPr(...)
                                                    (leases a token, hits GitHub, revokes)
                         ◄──────  stdin  ──────────  writes one line:
        ┌──────────────                              {type:'pr_comment_result',
        │  CommentPrCoordinator.handleResult()        id:'pr-comment-1', ok, reason?}
        │  resolves the pending promise
        ▼
 tool returns text to the agent
```

The gateway never runs the tool's logic. It receives data, does the privileged work itself,
and sends data back. The agent's model code stays inside the container the whole time.

## The five places a serviced tool lives

| # | Layer | File(s) | What lives here |
|---|---|---|---|
| 1 | Tool surface | `runner/src/main.ts` (`buildCommitMcpServer`) | The zod input schema, the `tool()` definition, and the handler that turns the coordinator's outcome into text for the agent. Tools register on an in-process MCP server with `alwaysLoad: true`. |
| 2 | Coordinator | `runner/src/<tool>.ts` | A small class that emits the request line and returns a promise it resolves when the matching result arrives. New ones compose the exported `RequestCoordinator` (`runner/src/request-coordinator.ts`) — hold it as a `private readonly base` and delegate, as `read-issue.ts`/`publish.ts` do; you don't subclass it. |
| 3 | Protocol | `src/runner/protocol.ts` **≡** `runner/src/protocol.ts` | The `request_*` / `*_result` message pair. The two copies must stay byte-identical. The runner parses inbound results in `runner/src/approval.ts` (`parseInbound`). |
| 4 | Gateway dispatch | `src/runner/docker.ts` | A branch in the read loop: validate the line, do the work, write the result back to the container's stdin. |
| 5 | Gateway service | `src/runner/<tool>-service.ts` (interface), `src/oneshot/<tool>-service.ts` (`Real*` impl), wired in `src/index.ts` | The code that performs the privileged work (the GitHub call, the credential lease). Injected into `DockerRunner` so tests can swap a fake. |

Two of these stay in lockstep by hand and break quietly if you forget: the protocol pair
(#3, both copies) and the dispatch branch matched to the service call (#4 ↔ #5).

### Two dispatch styles in `docker.ts`

The gateway answers a request in one of two ways. Pick the one that matches your tool:

- **Call an injected service, write the result.** `clone`, `publish`/`edit_pr`/`comment_pr`,
  `run_checks`, `provision`. The service is constructed in `index.ts` and injected through
  `DockerRunnerFactory` into `DockerRunner`. This is the default, and the right choice for a
  read or a single GitHub call.
- **Yield a `RunnerEvent` to the manager, get the answer via `next()`.** `build` and `exec`
  hand control up to `SessionManager` (which may run another container or check an opt-in),
  then feed the outcome back into the generator. Reach for this only when the work needs the
  manager's session state, not just a service call.

## Add a tool: the checklist

Mirror `edit_pr`/`comment_pr` end to end. In order:

1. **Protocol, both copies.** Add `RequestFooMessage` to the `RunnerToGatewayMessage` union
   and `FooResultMessage` to `GatewayToRunnerMessage`, in `src/runner/protocol.ts` *and*
   `runner/src/protocol.ts`. Keep them byte-identical (`diff` the two; the boundaries gate
   will not catch a drift). Add the inbound parse case in `runner/src/approval.ts`.
2. **Coordinator** (`runner/src/foo.ts`). Instantiate the exported `RequestCoordinator`
   (`runner/src/request-coordinator.ts`) with a tool-specific id prefix (`foo-`), a
   `fromMessage(msg)` mapping, and a shutdown outcome. The base owns the pending map, the id
   counter, and `failAllPending()` on stdin close, so you write only the mapping. You no
   longer need a bespoke coordinator class; a thin wrapper exposing a `requestFoo()` named
   method is optional sugar (see the publish family) but not required.
3. **Tool surface** (`runner/src/main.ts`). Add the zod schema, the `tool()` definition, and
   a small `runFoo()` that converts the outcome to agent-facing text. Add the tool to the
   array in `buildCommitMcpServer`, instantiate the coordinator in the main loop, route its
   result in the stdin demux, and call its `failAllPending()` on close.
4. **Service interface** (`src/runner/foo-service.ts`) and **real impl**
   (`src/oneshot/foo-service.ts`). Validate input (repo slug, non-empty fields), lease a
   credential from the broker if the call needs one, do the work, revoke in `finally`, and
   return `{ ok: true, ... }` or `{ ok: false, reason }`. Keep `reason` short and token-free.
5. **Gateway dispatch** (`src/runner/docker.ts`). Add a `serviceDispatch` config entry in the
   read loop instead of a hand-written branch:
   `const v = yield* self.serviceDispatch(parsed, { requestType, validate, statusText, invoke,
   toResult, malformedResult, toEvent? }); if (v === 'fatal') return; if (v === 'skipped')
   continue; deadline = Date.now() + turnTimeoutMs; continue;`. The helper owns the shared
   sequence (id-check, validation+fallback, status, the service call, the stdin-writable
   check, the result write, the optional event) and returns `'serviced' | 'skipped' | 'fatal'`
   so the deadline resets only when real work ran. `invoke` handles the service-wired check
   and returns the unavailable outcome itself. Add the service to the `DockerRunner` and
   `DockerRunnerFactory` constructors.
6. **Wire it** (`src/index.ts`). Construct the `Real*` service and pass it into the factory.
7. **Audit (optional).** If the action is worth a ledger row, yield a gateway-internal
   `RunnerEvent` (add the variant to `src/runner/types.ts`) and record it in
   `SessionManager`'s drain loop. `edit_pr`/`comment_pr` do this as `kind:'action'`
   (`tool:'edit-pr'`/`'comment-pr'`). Audit metadata only: a URL or a count, never body text.
8. **Tests.** See below.

Invariants the gate enforces or expects, all in play here:

- The two `protocol.ts` copies stay byte-identical.
- The gateway never runs agent code. A service does privileged work; it does not execute
  anything the model decided.
- Treat every protocol line as data. Validate types before use; a malformed line gets a
  failure result or a logged skip, never a throw that kills the turn.
- Never log message content or tokens. Logs and audit rows carry keys, sizes, and URLs only.
- No `any`, no `@ts-ignore`. `npm run gate` must pass.

## Correlation and lifecycle

Each coordinator stamps its requests with `"<prefix>-<n>"` (`pr-comment-1`, `clone-2`) and
keeps a pending map keyed by that id. The gateway echoes the id on the result, and
`handleResult()` resolves the matching promise. An id with no pending entry is logged and
ignored, so a stray or late line cannot crash the loop.

When the container's stdin closes, every coordinator's `failAllPending()` resolves its
waiters with `{ ok: false, reason: 'shutting down' }`, so a parked tool never hangs a dying
turn. On the gateway side, each serviced call resets the turn deadline once it returns, and
the service itself owns any network timeout (the GitHub client surfaces API errors through
`safeReason`; there is no retry or backoff today).

## Testing

The fakes already exist; use them rather than mocking the world.

| Layer | Test file (precedent) | Fake |
|---|---|---|
| Coordinator unit | `runner/test/publish.test.ts` | none needed (drive `handleResult` directly) |
| Tool result text | `runner/test/publish-tool.test.ts` | none needed |
| Gateway round trip | `test/docker-edit-comment-pr.test.ts` | `FakeChildProcess`, `FakePublishService` |
| Service unit | `test/publish-service.test.ts` | `FakeBroker`, `FakeGitNodeExecutor` |
| Manager audit | `test/manager.test.ts` | `FakeRunner` / `FakeRunnerFactory` |

The round-trip test is the one that proves the wiring: feed the `request_*` line into a
`FakeChildProcess`, assert the `*_result` line written back, assert the fake service was
called with the right DTO, and assert any gateway-internal event reached the consumer.

## Returning data to the agent (read tools)

Most results answer `{ ok, reason }`. Two already carry data back: `run_checks_result`
returns the check outcomes, and `publish_result` returns the PR URL. So a tool that returns
structured data is not new ground.

What *is* new for a read tool like `read_issue` is returning a large block of untrusted
free text (an issue body, a comment thread). That text is data the agent asked for, so it
flows back into the container by design. Cap it before it crosses: bound the body length the
way other content paths are bounded, and decide up front whether the result includes the
comment thread (a second GitHub call and a bigger payload) or just the title and body. The
token still never enters the container; the gateway makes the call and returns only the
text.

## Where this is heading

Two trim slices already cut the per-tool surface. The exported `RequestCoordinator`
(`runner/src/request-coordinator.ts`) now backs every request/result coordinator —
`clone`, `build`, `exec`, `checks`, `provision`, and the publish family — leaving one copy
of the pending/drain logic (`approval` stays standalone: it does file persistence and
verdict routing, not the simple request/result shape). And `serviceDispatch`
(`src/runner/docker.ts`) collapsed the six service-call branches into one config entry each.
A new service-call tool is now roughly a coordinator instantiation plus a `serviceDispatch`
config plus its service method.

`design/0018-tool-registry.md` proposes the next step: a registry that declares a tool once,
lets a profile select its subset, and makes the gateway dispatch table-driven so a new tool
is one registry entry rather than edits across the files above. Until that lands, adding a
tool means walking the checklist above.
