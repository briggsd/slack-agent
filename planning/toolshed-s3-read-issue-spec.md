# Task: add a VCS-agnostic `read_issue` tool (title + body + state + author)

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc, two packages). **Read the root `CLAUDE.md`, `runner/CLAUDE.md`, and
`docs/toolshed.md` first** — `docs/toolshed.md` is the add-a-tool guide and this is the
first tool built on the trimmed pattern it describes. You are on branch
`sonnet/toolshed-s3-read-issue`. Tracks `track fb841a`.

`read_issue` lets the agent read a repository issue from inside a thread: the model calls
`read_issue(repo, number)` and gets back the issue's title, body, state, and author. The
gateway holds the credential and makes the API call; the token never enters the container.

**Comments and listing are out of scope** (later slices). Return title/body/state/author
only.

## VCS-agnostic — do NOT hardcode GitHub

The repo already routes git-host calls through a neutral seam; use it so a GitLab provider
can be added later without touching this tool:

- `src/oneshot/git-host.ts` — the `GitHostProvider` interface and the `GithubProvider`
  impl, plus `providerFor(host: GitHost): GitHostProvider` (the single host→provider
  factory; GitLab currently throws "not yet supported").
- The provider is **stateless**; every method takes `token` and `fetchFn` per call.
- `CredentialLease` (`src/broker/types.ts`) carries `host` + `token`; the broker leases by
  host (`broker.lease({ host, repo, taskId })`).
- `exec` already threads a `host: ExecHost` selector through the protocol — mirror that.

`RealPublishService` (`src/oneshot/publish-service.ts`) is your service precedent;
`comment_pr` (PR #67) is your end-to-end tool precedent; `getChangeRequestState`
(`git-host.ts:277`) is your provider-method precedent (URL, Bearer header, `safeReason`
error handling, defensive field parsing).

## CRITICAL — do not stop after exploration

Do NOT pause or yield until the tool is implemented end to end AND `npm run gate` passes.
Make every edit, add tests, run the gate, fix failures, then stop. Zero-file-change yield is
a failure.

## CRITICAL — ground API + protocol, don't recall

Read the real `GitHostProvider`/`GithubProvider`, the protocol unions, and `RequestExecMessage`
(`src/runner/protocol.ts`) before writing. Use only symbols you can point to. The two
`protocol.ts` copies must end byte-identical.

## The change, layer by layer

### 1. Provider: add `getIssue` to the interface + GithubProvider (`src/oneshot/git-host.ts`)

Add to the `GitHostProvider` interface and implement in `GithubProvider`:
```ts
getIssue(req: { repo: string; number: number; token: string; fetchFn: FetchFn }):
  Promise<{ title: string; body: string; state: 'open' | 'closed'; author: string }>;
```
GithubProvider impl mirrors `getChangeRequestState`: `GET
https://api.github.com/repos/${repo}/issues/${number}` with the same headers
(`Authorization: Bearer`, `Accept: application/vnd.github+json`, `User-Agent`). On `!res.ok`
throw `GitHub API error ${status} fetching issue${await safeReason(res)}`. Parse defensively:
`title` (string; required), `body` (GitHub returns `string | null` — map `null`/missing to
`''`), `state` (string; map `'closed'` → `'closed'`, anything else → `'open'`), `user.login`
(string → `author`; map missing to `''`). Note the GitHub issues endpoint also returns PRs;
that is acceptable for a read.

### 2. Service: `ReadIssueService` interface + real impl

- `src/runner/read-issue-service.ts` (interface, gateway-internal seam):
  ```ts
  export interface ReadIssueServiceRequest { host: GitHost; repo: string; number: number; }
  export interface IssueData { title: string; body: string; state: 'open' | 'closed'; author: string; }
  export type ReadIssueOutcome = { ok: true; issue: IssueData } | { ok: false; reason: string };
  export interface ReadIssueService { readIssue(req: ReadIssueServiceRequest): Promise<ReadIssueOutcome>; }
  ```
- `src/oneshot/read-issue-service.ts` — `RealReadIssueService implements ReadIssueService`.
  Constructor `(broker: CredentialBroker, fetchFn: FetchFn = fetch)`. In `readIssue`:
  validate `SAFE_OWNER_REPO_SLUG.test(req.repo)` (reuse the regex pattern as used in
  `docker.ts`/services) and `Number.isInteger(req.number) && req.number > 0`, else
  `{ ok:false, reason:'invalid repo or issue number' }`. Then mirror RealPublishService's
  lease/try/finally:
  ```ts
  const lease = await this.broker.lease({ host: req.host, repo: req.repo, taskId: `read-issue:${req.repo}#${req.number}` });
  try {
    const raw = await providerFor(lease.host).getIssue({ repo: req.repo, number: req.number, token: lease.token, fetchFn: this.fetchFn });
    const body = raw.body.length > READ_ISSUE_BODY_MAX ? raw.body.slice(0, READ_ISSUE_BODY_MAX) : raw.body;
    return { ok: true, issue: { ...raw, body } };
  } catch (err) { return { ok: false, reason: safeReasonFrom(err) }; }
  finally { await lease.revoke(); }
  ```
  Define `READ_ISSUE_BODY_MAX = 16_384` (the issue body is untrusted external text flowing
  back to the agent — cap it). Derive the failure `reason` from the error message, short and
  token-free (mirror how RealPublishService turns a throw into `{ ok:false, reason }`). Do
  NOT log the issue body or token.

### 3. Protocol — both byte-identical copies (`src/runner/protocol.ts` ≡ `runner/src/protocol.ts`)

Add, mirroring the `request_exec`/`exec_result` pair (reuse the existing `ExecHost` type for
the host field — it is the protocol's `'github' | 'gitlab'` union):
```ts
export type RequestReadIssueMessage = { type: 'request_read_issue'; id: string; host: ExecHost; repo: string; number: number; };
export type ReadIssueResultMessage = {
  type: 'read_issue_result'; id: string; ok: boolean;
  issue?: { title: string; body: string; state: 'open' | 'closed'; author: string };
  reason?: string; // present iff !ok — short, token-free
};
```
Add `RequestReadIssueMessage` to the `RunnerToGatewayMessage` union and
`ReadIssueResultMessage` to `GatewayToRunnerMessage`. Add the inbound parse case for
`read_issue_result` in `runner/src/approval.ts` (`parseInbound`), mirroring
`pr_comment_result`. **`diff src/runner/protocol.ts runner/src/protocol.ts` must be empty.**

### 4. Gateway dispatch — via `serviceDispatch` (`src/runner/docker.ts`)

This is the trimmed pattern (`docs/toolshed.md`). Add a `request_read_issue` branch using the
existing `serviceDispatch` helper:
```ts
} else if (parsed.type === 'request_read_issue') {
  const verdict = yield* self.serviceDispatch<ReadIssueServiceRequest, ReadIssueOutcome>(parsed, {
    requestType: 'request_read_issue',
    validate: (p) => { /* host in {github,gitlab}; repo string + SAFE_OWNER_REPO_SLUG; number integer>0; else null. DTO { host, repo, number } */ },
    statusText: (req) => `reading issue #${req.number} in ${req.repo}…`,
    invoke: (req) =>
      self.readIssueService !== undefined
        ? self.readIssueService.readIssue(req)
        : Promise.resolve({ ok: false, reason: 'read_issue unavailable' } as ReadIssueOutcome),
    toResult: (id, outcome) => outcome.ok
      ? { type: 'read_issue_result', id, ok: true, issue: outcome.issue }
      : { type: 'read_issue_result', id, ok: false, reason: outcome.reason },
    malformedResult: (id) => ({ type: 'read_issue_result', id, ok: false, reason: 'malformed request' }),
    // no toEvent — a read is not audited as an action in this slice
  });
  if (verdict === 'fatal') return;
  if (verdict === 'skipped') continue;
  deadline = Date.now() + turnTimeoutMs;
  continue;
}
```
read_issue needs no `volume` (pure REST). Add `readIssueService?: ReadIssueService` to the
`DockerRunner` constructor and to `DockerRunnerFactory` (constructor + `create()`), mirroring
how `publishService` is threaded.

### 5. Runner tool + coordinator (`runner/src/`)

- New `runner/src/read-issue.ts`: define `ReadIssueInput { host: ExecHost; repo: string; number: number }`,
  the runner-side `ReadIssueOutcome` (`{ ok:true; issue:{title;body;state;author} } | { ok:false; reason:string }`),
  and `EmitRequestReadIssueFn`. Build the coordinator by instantiating the **exported**
  `RequestCoordinator` (`runner/src/request-coordinator.ts`) directly — per the trimmed
  pattern, no bespoke class is required, but a thin `ReadIssueCoordinator` wrapper exposing
  `requestReadIssue()` is fine if it reads cleaner (mirror `CommentPrCoordinator`). Prefix
  `'read-issue'`; `fromMessage` maps the result; shutdown outcome `{ ok:false, reason:'shutting down' }`.
- `runner/src/main.ts`: add a zod schema `{ repo: z.string(), number: z.number().int().positive(),
  host: z.enum(['github','gitlab']).optional() }`; a `read_issue` `tool()` whose handler calls
  a `runReadIssue(input, readIssue)` that returns agent-facing text. On success format the
  issue for the model (title, state, author, then body); on failure return a short reason
  line (mirror `runCommentPr`'s shape). Default `host` to `'github'` when omitted. Wire the
  coordinator: instantiate in the main loop with an emit closure, route `read_issue_result`
  in the stdin demux to `handleResult`, and call `failAllPending()` on stdin close. Add the
  tool to the `buildCommitMcpServer` tools array and thread the callback through
  `realSdkQuery`/`SdkQueryFn` the same way `comment_pr` is.

### 6. Wire the service (`src/index.ts`)

Construct `const readIssueService = new RealReadIssueService(broker);` next to
`RealPublishService` and pass it into `DockerRunnerFactory` (new constructor param), mirroring
`publishService`.

## Acceptance criteria

1. `npm run gate` passes (tsc + runner check + vitest + boundaries). Test count rises.
2. From a turn, a `read_issue` tool call emits `request_read_issue` and the gateway answers
   `read_issue_result` with `{ ok:true, issue:{title,body,state,author} }` for a valid issue,
   and `{ ok:false, reason }` on API error / unavailable / malformed.
3. The token never crosses into the container; the body is capped at `READ_ISSUE_BODY_MAX`.
4. Host is threaded end to end (tool → protocol → service → `providerFor(lease.host)`); no
   `'github'` literal in the read path except inside `providerFor`/the GitHub provider.
5. `diff src/runner/protocol.ts runner/src/protocol.ts` is empty.

## Tests (add all; use the existing fakes)

- **`test/git-host.test.ts`** — add `getIssue` cases mirroring the file's `FakeFetcher`
  pattern (`fetchFn as typeof fetch`): a well-formed issue JSON → parsed
  `{title,body,state,author}`; `body: null` → `''`; `state:'closed'` → `'closed'`; a non-ok
  response → throws with the `safeReason` message.
- **`test/read-issue-service.test.ts`** — `RealReadIssueService` with a `FakeBroker`
  (`src/broker/fake.ts`) + an injected `fetchFn`: happy path returns the issue and the lease
  is revoked; an oversized body is capped to `READ_ISSUE_BODY_MAX`; a fetch error →
  `{ ok:false, reason }` and the lease is still revoked; an invalid repo/number is rejected
  before leasing.
- **`test/docker-read-issue.test.ts`** — round-trip via `FakeChildProcess` + a
  `FakeReadIssueService` (add `src/runner/fake-read-issue-service.ts`, mirroring
  `fake-publish-service.ts`): a `request_read_issue` line drives a service call and a
  `read_issue_result` is written back with the issue; the missing-id / malformed paths behave
  per `serviceDispatch`.
- **runner side** — a `runReadIssue` tool-text test (mirror `publish-tool.test.ts`):
  success formats the issue, failure returns the reason. (The coordinator itself is covered
  by the shared `request-coordinator.test.ts`; you need not retest the base.)

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** (pass/fail counts) + `git diff --stat`.
- No `any`, no `@ts-ignore`, no non-null `!`. `NodeNext` ESM; honor `exactOptionalPropertyTypes`
  (build the optional `issue`/`reason` fields with `...(x !== undefined ? { x } : {})`).
- Both `protocol.ts` copies identical. The gateway never runs agent code; the read happens in
  the gateway service, not the container. **Never log the issue body or the token** (status,
  logs, audit carry repo + number only).
- No new runtime deps. `fetch` is the global (Node 20+); inject it for tests.
- Do NOT touch the bundled doc files (`docs/toolshed.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`,
  `runner/CLAUDE.md`) — they are already staged by the coordinator. Do NOT commit. Do NOT
  `git add -A`. (The spec + doc files are already committed as the branch's first commit.)

## Out of scope

- Issue comments, listing/searching issues, creating/editing issues.
- A GitLab provider (the seam must allow it; `providerFor('gitlab')` keeps throwing).
- Auditing reads / a `read_issue` ledger row. Per-thread repo binding.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each), incl. which test files you added.
- Real tail of `npm run gate` (pass/fail counts) + `git diff --stat`.
- Confirm `diff src/runner/protocol.ts runner/src/protocol.ts` is empty, and state old vs new
  test count.
- Any deviation from this spec and why.
