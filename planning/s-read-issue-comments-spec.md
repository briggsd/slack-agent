# Task: extend `read_issue` to also return issue comments (closes the factory-PR-summary read gap)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(this worktree is `../sa-wt-sonnet-read-issue-comments`, branch
`sonnet/read-issue-comments`). TypeScript, Node 20+, ESM, vitest, strict tsc.
**Read the root `CLAUDE.md` and `runner/CLAUDE.md` first** (gate, invariants,
conventions), then the context below.

## Context — read before writing code

Motivating bug (track `0c62a5`): the agent can ship a PR but cannot iterate on
review feedback, because `read_issue` returns only the issue *body*, never its
comments. On a live run the bot saw only the issue body for #315 and could not
read the AI-review-factory's findings. GitHub posts general PR comments (including
the factory's summary) to `issues/{n}/comments` — the **same** endpoint that holds
issue comments — so one change closes both: issue-thread comments AND the factory's
PR summary comment (a PR is an issue for general comments on GitHub).

This is the **gateway-serviced tool** pattern (see `docs/toolshed.md`). `read_issue`
already implements the full five-file chain; this slice extends it in place. The
chain (read all of these — these are the files you touch):

- `src/oneshot/git-host.ts` — `GithubProvider`. `getIssue` (lines ~284–316) GETs
  `repos/{repo}/issues/{number}`. The provider interface `GitHostProvider` (lines
  ~30–86) declares `getIssue`. You add a sibling `getIssueComments`.
- `src/oneshot/read-issue-service.ts` — `RealReadIssueService.readIssue` (lines
  ~40–70): mints a READ lease, calls `providerFor(host).getIssue(...)`, caps the
  body at `READ_ISSUE_BODY_MAX` (16384, exported line ~20), revokes the lease in a
  `finally`, never throws. You add a comments fetch here.
- `src/runner/read-issue-service.ts` — the gateway-side seam. `IssueData` (lines
  17–22) = `{ title; body; state; author }`. You add `comments`.
- `src/runner/protocol.ts` **and** `runner/src/protocol.ts` — the two
  byte-identical copies. `ReadIssueResultMessage.issue` (lines ~194–200) is an
  inline literal `{ title; body; state: 'open'|'closed'; author }`. You add
  `comments` to **both** copies, identically.
- `runner/src/read-issue.ts` — container-side coordinator. `ReadIssueOutcome`
  (lines 13–15) has an inline `issue` literal mirroring the protocol. Add
  `comments` here too. (The coordinator class needs no logic change — it just
  passes `msg.issue` through; verify that.)
- `runner/src/main.ts` — `runReadIssue` formatter (lines ~483–498) builds the text
  the agent sees; the `read_issue` tool description (lines ~1451–1456) and
  `readIssueSchema` (lines ~1390–1394). The schema/input args do NOT change (no new
  tool parameter — comments come back automatically).
- `src/runner/fake-read-issue-service.ts` — `FakeReadIssueService` default outcome
  (lines ~14–22) constructs an `IssueData` literal; it gains `comments`.
- `src/runner/docker.ts` — the gateway dispatch (lines ~825–857) validates the
  request and maps the outcome to `read_issue_result`. It spreads
  `issue: outcome.issue` through (line ~848), so **no dispatch logic change** is
  needed — the wider `issue` shape flows through. Verify, don't edit unless the
  types force it.

Existing tests you will extend (every literal that builds a full `IssueData` /
`issue` shape must gain `comments` once the field is required):
`test/read-issue-service.test.ts`, `test/docker-read-issue.test.ts`,
`runner/test/read-issue-tool.test.ts`, `test/git-host.test.ts`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the slice is fully implemented AND
`npm run gate` passes. Make every edit, add/extend tests, run the gate, fix
failures, then stop. Yielding after only exploring is a failure.

## Design decisions (DECIDED — implement exactly this, do not re-litigate)

1. **New comment shape.** Add an exported type to `src/runner/read-issue-service.ts`:
   ```ts
   export interface IssueComment {
     author: string;  // commenter login, '' if absent
     body: string;    // capped at READ_ISSUE_BODY_MAX
   }
   ```
   `IssueData` gains a **required** field `comments: IssueComment[]` (not optional —
   an empty thread is `[]`, never `undefined`; this keeps it clean under
   `exactOptionalPropertyTypes`). The protocol and runner inline literals gain the
   same `comments: { author: string; body: string }[]` field (required, inline —
   the protocol copies must not import named types; keep them self-contained as
   today).

2. **New caps constant.** In `src/oneshot/read-issue-service.ts`, export
   `READ_ISSUE_COMMENTS_MAX = 30`. The service returns at most this many comments
   (oldest-first, GitHub's default order); each comment body is capped at the
   existing `READ_ISSUE_BODY_MAX` exactly as the issue body already is.

3. **New provider method `getIssueComments`** on `GitHostProvider` +
   `GithubProvider`:
   ```ts
   getIssueComments(req: {
     repo: string; number: number; token: string; fetchFn: FetchFn;
   }): Promise<Array<{ author: string; body: string }>>;
   ```
   GitHub impl: `GET https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=100`
   with the same Bearer/Accept/User-Agent headers as `getIssue`. On `!res.ok`,
   throw `GitHub API error ${res.status} fetching issue comments${await safeReason(res)}`
   (mirror `getIssue`). Parse the JSON array defensively (it must be an array;
   throw a clear error if not). For each entry, map `body` (null/non-string → '')
   and `user.login` (non-string → '') exactly as `getIssue` maps the issue body and
   author. Return ALL parsed comments from the page (the service applies the count
   cap, not the provider). Single page only — no pagination (the factory case is
   1–2 comments; 100/page is ample for the POC).

4. **Service wiring** (`RealReadIssueService.readIssue`): after the successful
   `getIssue`, in the **same** `try` (so the lease is live and revoked in the same
   `finally`), call `getIssueComments`. Then:
   - cap the count to `READ_ISSUE_COMMENTS_MAX` (`slice(0, MAX)`),
   - cap each comment body to `READ_ISSUE_BODY_MAX` (reuse the same slice logic as
     the issue body),
   - return `{ ok: true, issue: { ...raw, body, comments } }`.
   **A comments-fetch failure FAILS the read** (falls into the existing `catch` →
   `{ ok: false, reason: safeReasonFrom(err) }`). Do NOT swallow it to `[]`:
   silently dropping review comments is the exact bug this slice fixes, so an
   honest failure the agent can retry is correct. The lease still revokes in the
   `finally`.

5. **Formatter** (`runReadIssue` in `runner/src/main.ts`): keep the existing
   header/body block, then append a comments section. Suggested shape (match the
   existing terse style):
   ```
   ISSUE #42 (open) — Title
   Author: reporter

   <body>

   --- COMMENTS (N) ---

   [1] alice:
   <comment body>

   [2] bob:
   <comment body>
   ```
   When `comments` is empty, append `--- COMMENTS (0) ---` then `No comments.` so
   the agent can distinguish "read succeeded, none present" from a failure. Never
   log any comment text (same redaction rule as the body).

6. **Tool description** (`read_issue` tool, `runner/src/main.ts` ~1453): update the
   prose to say it now also returns up to 30 comments (issue thread / general PR
   comments incl. CI review summaries), each body capped at 16384 chars. Do NOT add
   a tool parameter.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the new ones).
   `boundaries` clean. The two `protocol.ts` copies remain **byte-identical**
   (`diff src/runner/protocol.ts runner/src/protocol.ts` → no output).
2. `GithubProvider.getIssueComments` GETs `issues/{number}/comments?per_page=100`,
   parses author+body defensively, and throws a token-free `safeReason` message on
   a non-ok response. New tests in `test/git-host.test.ts` cover: happy parse,
   null-body → '', non-ok throw that does not leak the token, non-array body throw.
3. `RealReadIssueService.readIssue` returns `comments` on success (count capped at
   `READ_ISSUE_COMMENTS_MAX`, each body capped at `READ_ISSUE_BODY_MAX`), and
   returns `ok:false` + revokes the lease when the comments fetch fails. New tests
   in `test/read-issue-service.test.ts` cover: comments returned + count cap +
   per-comment body cap; comments-fetch error → ok:false with the lease revoked.
   (Use the existing fake-provider / fetch seam already used in that file.)
4. `runReadIssue` renders the comments section (header with count + each comment;
   `No comments.` when empty). Extend `runner/test/read-issue-tool.test.ts` to
   assert the rendered comments and the empty-thread wording.
5. The protocol round-trip still works end to end: `test/docker-read-issue.test.ts`
   passes with `comments` present in the `issue` literal it asserts.

## Hard constraints (do NOT violate)

- The gate must pass; paste the tail of its output when done.
- `protocol.ts`: edit **both** copies identically — they MUST stay byte-identical.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers); inject deps
  (use the existing fake/fetch seams — no real network/Slack/Docker/API in tests).
- **Never log message contents or tokens** — not the body, not any comment text.
  The error path stays token-free (`safeReason` / `safeReasonFrom` only).
- The gateway never imports the Agent SDK or the `runner/` package; `@slack/bolt`
  only in `src/index.ts`. (You touch neither — just don't introduce a cross-import.)
- No new dependencies.
- Do NOT commit — leave the working tree for review. Do NOT touch this spec file.

## Out of scope (do NOT build)

- **PR review threads** — `pulls/{n}/comments` (inline) and `pulls/{n}/reviews`
  (summaries). That is part (2) of `0c62a5`, a separate later slice. This slice is
  part (1) only: general issue/PR comments via `issues/{n}/comments`.
- Any new tool, new tool parameter, pagination, or comment timestamps/reactions.
- GitLab (`providerFor('gitlab')` still throws as today).

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased), and the result of
  `diff src/runner/protocol.ts runner/src/protocol.ts` (must be empty).
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
