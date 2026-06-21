# Task: publish-cluster Slice 2 — `edit_pr` + `comment_pr` (mutate the thread's PR)

You are implementing one well-scoped slice in **slack-agent** (TypeScript, Node 20+, ESM,
`NodeNext`, strict tsc with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, vitest).
**Read the root `CLAUDE.md` and `runner/CLAUDE.md` first** for conventions (gate, invariants),
then implement the acceptance criteria below. You are on branch `codex/5e9ee3-edit-comment-pr`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run gate` passes
(run from the repo root; it covers gateway + runner type-check + vitest + boundaries). Make every
edit, add tests, run the gate, fix failures, then stop. Yielding after only exploring (zero file
changes) is a failure — implement end-to-end in this run.

## Why (context — the design note is gitignored/absent here, so it's inlined)

The PR lifecycle is half-owned by the gateway: it *opens* a PR but can't touch it afterward. A
live test left a stale "not executed" caveat in a PR body with no way to fix it from inside the
sandbox. This slice adds **`edit_pr`** (replace title/body) and **`comment_pr`** (add a comment)
to the existing publish capability cluster.

**Decided design (do not deviate):**
- **One gateway-owned PR lifecycle.** The gateway holds credentials and performs every GitHub
  write; the container only *requests*. This is the existing trust boundary — keep it.
- **PR identity is the THREAD's PR, resolved gateway-side from the session's branch — NEVER a
  model-supplied PR number.** By branch-per-thread, the session has one deterministic branch
  (`branchForTask(taskIdFromWorkspaceVolume(volume))`). `edit`/`comment` resolve the open PR for
  that head branch via a new GitHub API lookup. The model cannot target an arbitrary PR — that
  dangerous degree of freedom is removed by construction, not validated after.
- **Extend the existing `PublishService`** (open → edit → comment) — one service, one credential
  seam. Do NOT create parallel service classes.
- **The model authors content; the gateway sends it.** Title/body/comment text is model-authored
  (the deliverable — it legitimately goes to GitHub). The no-content rule applies to **logs and
  audit only**: never log the body/comment; audit rows carry the PR URL + metadata, never text.
- **Failures are data, not exceptions** (`{ ok: false, reason }`) — refusal-as-data, like the
  rest of the tool surface.

## The shape to mirror — `publish` end-to-end

`edit_pr`/`comment_pr` are structurally near-identical to the existing `publish`/`open_pr` flow.
**Find how `publish` is plumbed across these layers and mirror it.** The one genuinely new piece
is the GitHub API methods + by-head PR resolution (section F).

### A. Protocol — `src/runner/protocol.ts` ≡ `runner/src/protocol.ts` (BYTE-IDENTICAL — edit BOTH)

These two files MUST stay byte-identical (it's a boundary-enforced invariant; `npm run
boundaries` + a diff check guard it). Make the SAME edits in both.

Mirror `RequestPublishMessage` (~line 301) and `PublishResultMessage` (~line 114). Add four types:
```ts
export type RequestPrEditMessage = {
  type: 'request_pr_edit';
  id: string;
  repo: string;     // "owner/name"
  title?: string;   // optional new title
  body?: string;    // optional new body
};
export type PrEditResultMessage = {
  type: 'pr_edit_result';
  id: string;
  ok: boolean;
  reason?: string;  // present iff !ok — short, token-free
};
export type RequestPrCommentMessage = {
  type: 'request_pr_comment';
  id: string;
  repo: string;     // "owner/name"
  comment: string;  // comment text (required)
};
export type PrCommentResultMessage = {
  type: 'pr_comment_result';
  id: string;
  ok: boolean;
  reason?: string;
};
```
Add `RequestPrEditMessage | RequestPrCommentMessage` to the **`RunnerToGatewayMessage`** union
(~line 162) and `PrEditResultMessage | PrCommentResultMessage` to the **`GatewayToRunnerMessage`**
union (~line 20). If those files have a runtime parse/validate function that maps wire messages to
a `{ kind, msg }` discriminated shape (the runner consumes `parsed.kind === 'publish_result'` in
`runner/src/main.ts` ~line 549), extend it for the two new result kinds the same way publish is
handled. **After editing, confirm `diff src/runner/protocol.ts runner/src/protocol.ts` prints
nothing.**

### B. Service interface — `src/runner/publish-service.ts`

Extend the existing `PublishService` interface (don't add a new one). Mirror
`PublishServiceRequest`/`PublishOutcome` (~lines 1–23):
```ts
export interface PrEditServiceRequest { repo: string; volume: string; title?: string; body?: string; }
export type PrEditOutcome = { ok: true; prUrl: string } | { ok: false; reason: string };

export interface PrCommentServiceRequest { repo: string; volume: string; comment: string; }
export type PrCommentOutcome = { ok: true; prUrl: string } | { ok: false; reason: string };

export interface PublishService {
  publish(req: PublishServiceRequest): Promise<PublishOutcome>;
  editPr(req: PrEditServiceRequest): Promise<PrEditOutcome>;       // NEW
  commentPr(req: PrCommentServiceRequest): Promise<PrCommentOutcome>; // NEW
}
```
(`prUrl` in the outcome is for the manager's audit row — see section E.)

### C. Real impl — `src/oneshot/publish-service.ts` (`RealPublishService`)

Mirror `RealPublishService.publish` (~lines 28–99), but **edit/comment do NOT push and need no
workdir/`verifyRepo`** — they resolve the PR by head branch and call the GitHub API. For each:
1. Validate `req.repo` with the file-local `isSafeOwnerRepoSlug` (~line 18) → `{ ok:false, reason:'invalid repo (expected "owner/name")' }`.
2. Derive the branch: `branchForTask(taskIdFromWorkspaceVolume(req.volume))` (already imported, ~line 12).
3. Lease creds via the broker with the same lease/`revokeOnce`-in-`finally` pattern as `publish`
   (~lines 53–65, 95–96): `taskId = \`${Date.now()}-${Math.random().toString(36).slice(2,9)}\``,
   `this.broker.lease({ host: 'github', repo: req.repo, taskId })`; on lease failure
   `{ ok:false, reason:'credential lease failed' }`.
4. Inside `try { … } finally { await revokeOnce(); }`, call the new `GitNodeExecutor` method
   (section D): `editChangeRequest` / `commentChangeRequest`, passing `{ lease, repo, head: branch,
   … }`. Map its result to the outcome; on the "no open PR for this branch" case return
   `{ ok:false, reason:'no open PR for this thread' }`; on other failures
   `{ ok:false, reason:'edit PR failed' }` / `'comment PR failed'`. Return `{ ok:true, prUrl }` on
   success (prUrl comes from the resolved PR).
   - `cleanOptionalText` (used by `publish` for title/body, ~line 42) should be reused for the
     edit title/body so empty strings normalize the same way.

### D. Git-node executor — interface `src/oneshot/git-node.ts` + impls

Add to the `GitNodeExecutor` interface (~line 99) two methods, mirroring `openChangeRequest`
(~line 106). They resolve the PR number by head internally, then call the provider:
```ts
editChangeRequest(req: { lease: CredentialLease; repo: string; head: string; title?: string; body?: string }):
  Promise<{ prUrl: string } | { notFound: true }>;
commentChangeRequest(req: { lease: CredentialLease; repo: string; head: string; comment: string }):
  Promise<{ prUrl: string } | { notFound: true }>;
```
(Use a `{ notFound: true }` sentinel for "no open PR for this head" so the service can map it to
the honest `reason` without a thrown error. Define small named request/return interfaces in
`git-node.ts` next to `OpenChangeRequest`, in that file's style.)

- **Real impl — `src/oneshot/docker-git-node.ts`** (`DockerGitNodeExecutor`): mirror
  `openChangeRequest` (~lines 426–441). `const provider = providerFor(req.lease.host);` then
  `const found = await provider.getChangeRequestByHead({ repo: req.repo, head: req.head, token:
  req.lease.token, fetchFn: this.fetchFn });` — if `found === null` return `{ notFound: true }`;
  else call `provider.editChangeRequest(...)` / `provider.addChangeRequestComment(...)` with
  `number: found.number`, returning `{ prUrl: found.url }`. (The provider methods are section F.)
- **Fake — `src/oneshot/fake-git-node.ts`**: add `editChangeRequest`/`commentChangeRequest`
  mirroring the fake `openChangeRequest` (~line 136) — record the calls on public arrays for test
  assertions, return a scripted `{ prUrl }` by default, and expose setters to script
  `{ notFound: true }` and rejection (mirror the existing `setVerifyRepoResult` /
  open-change-request-rejection scripting helpers ~lines 64–74).

### E. Gateway docker seam — `src/runner/docker.ts` + RunnerEvent + manager audit

- **`docker.ts` request handlers:** mirror the `request_publish` handler (~lines 551–613) for
  `request_pr_edit` and `request_pr_comment`. Validate `id`/`repo` (and `comment` is a non-empty
  string for comment; `title`/`body` optional strings for edit) → on malformed, write the
  `*_result { ok:false, reason:'malformed request' }` back. Build the service request with
  `self.volume`. Call `self.publishService.editPr(...)` / `.commentPr(...)` (guard
  `self.publishService !== undefined && self.volume !== undefined`, else `reason:'edit unavailable'`
  / `'comment unavailable'`). Write the `*_result` line back to the container. On success, `yield`
  a RunnerEvent (next bullet). Reset the turn deadline (`deadline = Date.now() + turnTimeoutMs`,
  ~line 612) like publish does. `self.publishService` is already injected (no new constructor wiring
  — you're extending the same service object; `index.ts` already builds it ~line 118).
- **RunnerEvent union — `src/runner/types.ts`** (~lines 1–36): add
  `| { type: 'pr_edited'; url: string }` and `| { type: 'pr_commented'; url: string }` (mirror
  `pr_opened`). docker yields these on success (carry the resolved `prUrl`).
- **Manager — `src/sessions/manager.ts`** drain loop: in the same `else if (event.type === …)`
  chain where `pr_opened` is handled (~line 793), add `pr_edited` and `pr_commented` cases. They
  **audit only — no Slack post, no `recordPullRequest`, no `captured`, do not break** (the PR
  already exists; the coordinator narrates the outcome). Mirror the `pr_opened` `this.audit({…})`
  call (~line 798) exactly, including `profile_id: session.profileId` (audit now REQUIRES
  `profile_id`):
  ```ts
  } else if (event.type === 'pr_edited') {
    this.audit({ session_key: session.key, team_id: session.teamId ?? null,
      user_id: session.requestorUserId ?? null, profile_id: session.profileId,
      kind: 'action', tool: 'edit-pr', summary: event.url, result: 'edited' });
  } else if (event.type === 'pr_commented') {
    this.audit({ session_key: session.key, team_id: session.teamId ?? null,
      user_id: session.requestorUserId ?? null, profile_id: session.profileId,
      kind: 'action', tool: 'comment-pr', summary: event.url, result: 'commented' });
  }
  ```
  `summary` carries the PR URL (metadata — fine); never put title/body/comment text in audit.

### F. GitHub provider — `src/oneshot/git-host.ts` (the genuinely new API surface)

Add three methods to the `GitHostProvider` interface (~line 30) and implement them on
`GithubProvider` (~line 58), mirroring `openChangeRequest`/`getChangeRequestState` (~lines 90–174)
— same `Authorization: Bearer`/`Accept`/`User-Agent` headers, the `safeReason(res)` error helper
(~line 18), and defensive response-field validation:

```ts
// Resolve the open PR for a head branch. owner = repo.split('/')[0]; GitHub's head filter is
// `owner:branch`. Returns null when there is no open PR (NOT an error).
getChangeRequestByHead(req: { repo: string; head: string; token: string; fetchFn: FetchFn }):
  Promise<{ number: number; url: string; headSha: string } | null>;
//   GET /repos/{repo}/pulls?head={owner}:{branch}&state=open
//   res not ok → throw (use safeReason); res.json() is an array; [] → return null;
//   else validate html_url/number/head.sha on element [0] like openChangeRequest does.

// Edit an existing PR's title and/or body (only send provided fields).
editChangeRequest(req: { repo: string; number: number; token: string; fetchFn: FetchFn; title?: string; body?: string }):
  Promise<{ url: string }>;
//   PATCH /repos/{repo}/pulls/{number}  body { ...(title!==undefined && {title}), ...(body!==undefined && {body}) }
//   validate html_url on the response.

// Add an issue comment to a PR (PR comments are issue comments).
addChangeRequestComment(req: { repo: string; number: number; token: string; fetchFn: FetchFn; comment: string }):
  Promise<{ url: string }>;
//   POST /repos/{repo}/issues/{number}/comments  body { body: req.comment }
//   validate html_url on the response (the comment's url is fine for audit; or return the PR url —
//   prefer returning the PR html_url the caller already resolved via getChangeRequestByHead, so the
//   audit points at the PR, not the comment anchor).
```
Note: `DockerGitNodeExecutor.editChangeRequest`/`commentChangeRequest` (section D) call
`getChangeRequestByHead` first, then `editChangeRequest`/`addChangeRequestComment`, and surface the
PR's `url` (from the by-head lookup) as `prUrl`.

### G. Runner-side tools + coordinators — `runner/src/`

Mirror the publish tooling:
- **`runner/src/publish.ts`** has `PublishCoordinator` (~lines 26–75) + `runPublish` helper. Add
  `EditPrCoordinator` / `CommentPrCoordinator` (identical request/handleResult/failAllPending
  pattern, ids `pr-edit-${n}` / `pr-comment-${n}`) and `runEditPr` / `runCommentPr` text helpers.
  Put them in `runner/src/publish.ts` (same cluster) or a sibling file — match the repo's choice;
  `publish.ts` is fine.
- **`runner/src/main.ts`:** define `editPrTool` and `commentPrTool` (mirror `publishTool` ~line
  1003, with zod schemas mirroring `publishSchema`: edit = `{ repo, title?, body? }`, comment =
  `{ repo, comment }` where `comment` is required). Register them in the `tools: [...]` array of
  `createSdkMcpServer` (~line 1124). Wire the coordinators in `runLoop` (mirror ~lines 460–471) so
  the tool emits `request_pr_edit`/`request_pr_comment`, add inbound dispatch for
  `pr_edit_result`/`pr_comment_result` (mirror ~line 549), and call their `failAllPending()` in the
  `rl.on('close')` shutdown (~line 591). Tool descriptions: make clear the gateway owns creds and
  the PR is **this thread's** PR (no PR-number argument exists by design).

## Test infrastructure (how to test this — the hard part, do not skip)

Mirror the publish tests; use the existing fakes (no network/Docker/Slack):
- **Provider — `test/git-host.test.ts`** (if present; else add): test `getChangeRequestByHead`
  (array→first / empty→null / non-ok→throws), `editChangeRequest` (PATCH body only includes
  provided fields), `addChangeRequestComment`. Inject a fake `fetchFn` that asserts URL/method/body
  and returns scripted `Response`s (mirror how existing provider tests stub `fetch`).
- **Gateway round-trip — `test/docker-publish.test.ts`** is the template (`FakeChildProcess` +
  `FakePublishService`). Add a `test/docker-edit-comment-pr.test.ts`: push a `request_pr_edit` /
  `request_pr_comment` stdout line, assert the gateway writes back the correct `*_result` message,
  assert the service was called with `{ repo, volume, … }`, and assert the runner yields the
  `pr_edited` / `pr_commented` RunnerEvent (and that a failure outcome yields NO event and an
  `ok:false` result). Extend `FakePublishService`
  (`src/runner/fake-publish-service.ts`) with `editPr`/`commentPr` (record calls + scriptable
  outcome, mirroring its `publish` ~lines 1–26).
- **Real service — `test/publish-service.test.ts`** is the template: add `editPr`/`commentPr` tests
  using `FakeGitNode` (script `{ notFound: true }` → outcome `reason:'no open PR for this thread'`;
  script success → `{ ok:true, prUrl }`; assert broker lease + revoke happened).
- **Manager audit — `test/manager.test.ts`:** mirror the `pr_opened` audit test — drive a
  `pr_edited` / `pr_commented` event through the drain loop and assert an audit row with
  `tool:'edit-pr'`/`'comment-pr'`, `result:'edited'`/`'commented'`, `profile_id` = the session's
  profile, and that NO `recordPullRequest` row is written and NO Slack post is made.
- **Runner coordinator/tool — `runner/test/publish-tool.test.ts`** is the template: test
  `runEditPr`/`runCommentPr` text output and the `EditPrCoordinator`/`CommentPrCoordinator`
  request→handleResult round-trip (including unknown-id and `failAllPending`).

## Hard constraints (do NOT violate)

- `npm run gate` (from repo root) must pass — paste the real tail (vitest pass/fail counts +
  boundaries). The suite is **offline** — no Slack/Docker/API/network; stub `fetch` via `fetchFn`.
- **`protocol.ts` two copies stay byte-identical** — edit both; `diff` them; this is
  boundary-enforced.
- **No `any`, no `@ts-ignore`.** `NodeNext` ESM (`.js` import specifiers). Honor
  `noUncheckedIndexedAccess` (array access from the GitHub list response is `T | undefined` — guard
  it) + `exactOptionalPropertyTypes` (build optional fields conditionally:
  `...(title !== undefined && { title })`).
- **Never log or audit message/PR text** — only the PR URL + metadata. The PR body/title/comment
  is model-authored content that goes to GitHub (expected) but is never written to logs or audit.
- **The gateway owns credentials and performs every write; the container only requests** — do not
  add any path that lets the container hold a token or hit GitHub directly.
- **`@slack/bolt` only in `src/index.ts`; the gateway never imports the Agent SDK or `runner/`**
  (boundary-enforced). This slice touches neither boundary — keep it that way.
- **Never `git add -A`/`git add .`** — stage explicit paths. Do NOT commit (the coordinator
  commits). Do NOT touch this spec file.

## Out of scope (do NOT build)

- Editing/commenting on **any PR other than this thread's own** (no PR-number argument — ever).
- PR review/merge/close operations (humans merge — the bot never merges).
- Issue create/comment (a different write surface — parked, `8d8cdb`).
- Comment **upsert** / idempotency: a repeated `comment_pr` posts a NEW comment (natural) — do not
  build edit-existing-bot-comment dedup.
- Edit **patch/append** semantics: `edit_pr` is a full title/body **replace** (the model holds the
  intended content).

## When done — report precisely (with REAL command output)

Before reporting, RUN and paste the ACTUAL output of: `git status --short`, `git diff --stat`,
`diff src/runner/protocol.ts runner/src/protocol.ts` (must be empty), and the full `npm run gate`
tail (vitest pass/fail counts + boundaries result). **Do not describe any change you cannot point
to in `git diff`** — the coordinator reconciles your summary against the diff; a claimed-but-absent
change (especially tests) is a failure. If you could not finish a criterion, SAY SO explicitly.

Then: (1) files changed and why, one line each; (2) the exact GitHub API calls you added (method +
path + which response fields you validate); (3) how the tests exercise each layer (confirm the new
test files appear in `git diff --stat` and the test count rose); (4) anything you could not satisfy.
