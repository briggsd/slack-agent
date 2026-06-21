# Task: capture opened PRs into a `pull_requests` table (0015 acceptance metric — slice 1, foundation)

You are implementing one slice in this worktree
(`/Users/jedanner/workspace/sa-wt-codex-0015-s1-pr-tracking`, a checkout of the
slack-agent repo — TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `AGENTS.md` first** (the gate, invariants, branch+PR workflow), then
the context below. You are already on branch `codex/0015-s1-pr-tracking` — do NOT
create a new branch, do NOT commit to `main`. `node_modules` is symlinked, so the
gate runs offline without `npm ci`.

## What this slice delivers (and what it does NOT)

This is the **foundation** for an acceptance metric: when the bot opens a PR, record
a durable row in a new `pull_requests` table with the data a later reconciliation pass
will need (PR number, the head SHA the bot pushed, the profile, the repo). **This
slice does NOT poll GitHub or reconcile PR state** — no network reads, no timer. It
only captures, at open time, what slice 2 will reconcile. Building past that is
out of scope (see below).

The two facts that shape this: today `openChangeRequest` returns only `{ url }` and
**discards the PR `number` and `head.sha` that the GitHub response contains**; and
`pr_opened` is a **gateway-internal `RunnerEvent`, NOT a protocol/wire message**, so
carrying new fields on it does NOT touch `protocol.ts`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND `npm run
gate` passes. Make every edit, add tests, run the gate, fix failures, then stop.
Yielding after only exploring (zero file changes) is a failure — implement end to end.

## Grounded seams (current line numbers; verify, they're freshly checked)

- **Provider return** — `src/oneshot/git-host.ts`:
  - `GitHostProvider` interface (`:30–48`): `openChangeRequest(req: {...}): Promise<{ url: string }>`.
  - `GithubProvider.openChangeRequest` (`:83–119`): does `POST /repos/${repo}/pulls`, then
    `:114` `const data = (await res.json()) as { html_url?: unknown };` and returns
    `{ url: data.html_url }` after validating it's a non-empty string. The real GitHub
    response also has `number` (a number) and `head.sha` (a string) — currently discarded.
  - GitLab branch of `providerFor` (`:122–135`) **throws** — leave it untouched.
- **Executor passthrough** — `src/oneshot/docker-git-node.ts` `openChangeRequest` (`:426–441`)
  returns `provider.openChangeRequest(...)` directly — widen with the provider.
- **Internal publish outcome** — `src/runner/publish-service.ts:16–18`:
  `export type PublishOutcome = { ok: true; prUrl: string } | { ok: false; reason: string }`.
  `src/oneshot/publish-service.ts:81–91` calls `gitNodes.openChangeRequest(...)` and
  `return { ok: true, prUrl: url }`. `PublishServiceRequest` (`runner/publish-service.ts:9`)
  carries `repo`. **This is the gateway-internal return — extend it. Do NOT change the
  `publish_result` PROTOCOL message** (`src/runner/protocol.ts`, `runner/src/protocol.ts`);
  the container/agent does not need the number/sha.
- **The `pr_opened` event** — declared in `src/runner/types.ts:20` and
  `src/sessions/manager.ts:25` as `{ type: 'pr_opened'; url: string }`. Yielded at two
  sites: `src/runner/docker.ts:602` (conversational publish path — `publishOutcome.prUrl`,
  with `publishReq.repo` in scope) and `src/oneshot/nodes/open-pr.ts:81` (one-shot node —
  has `ctx`). Handled at `src/sessions/manager.ts:759` (posts to Slack + writes the
  `open-pr` audit event), where `session` is in scope.
- **`OneShotContext`** — `src/oneshot/context.ts:19–39` (`prUrl?: string` set at
  `open-pr.ts:78`). Add `prNumber?` / `prHeadSha?` the same way.
- **`Session`** — `src/sessions/manager.ts:47` (`profileId: string` at `:50`, required).
- **Store** — `src/sessions/store.ts`: `SessionStore` interface; `SqliteSessionStore`
  with schema in the constructor (`audit_events` at `:286–301`, indexes `:308–313`),
  prepared statements built in the constructor (pattern: a typed `db.prepare<[...]>(...)`
  field + a method that calls `.run(...)`/`.get(...)`); `NoopSessionStore` at the bottom
  with no-op methods. Mirror `recordSession`/`recordAudit` exactly for the new write.
- **Injected clock** — `SessionManager` has `this.now()` (`manager.ts:163`). Use it for
  `opened_at` (not `Date.now()`), so slice 2's reconciliation windows stay testable.

## What to build

1. **New `pull_requests` table** in `SqliteSessionStore` (`store.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS pull_requests (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     session_key    TEXT    NOT NULL,
     repo           TEXT    NOT NULL,
     pr_number      INTEGER NOT NULL,
     head_sha       TEXT    NOT NULL,
     profile_id     TEXT    NOT NULL,
     opened_at      INTEGER NOT NULL,
     state          TEXT    NOT NULL DEFAULT 'open',
     last_polled_at INTEGER,
     resolved_at    INTEGER
   );
   ```
   Add an index on `state` (the reconciliation worklist filters open rows):
   `CREATE INDEX IF NOT EXISTS pr_by_state ON pull_requests (state);`
   - Types: `PullRequestRow` (all columns, required-with-null for the nullables —
     `last_polled_at: number | null`, `resolved_at: number | null`; `state: string`) and
     `NewPullRequestRow = Pick<...>` of the caller-supplied fields
     (`session_key, repo, pr_number, head_sha, profile_id, opened_at` — `state` defaults
     to `'open'` in SQL; `last_polled_at`/`resolved_at` start null). Follow the
     `NewSessionRow` required-with-null house style (see `store.ts` `AuditEvent` comment).
   - Method `recordPullRequest(row: NewPullRequestRow): void` (prepared INSERT, mirroring
     `recordSession`). Add it to the `SessionStore` interface and a no-op in
     `NoopSessionStore`.
   - Add a read method `listOpenPullRequests(): PullRequestRow[]` (SQL:
     `SELECT * ... WHERE state = 'open'`) — slice 2's reconciliation worklist, and needed
     here so the write is testable. No-op returns `[]` in `NoopSessionStore`.

2. **Capture number + head SHA from GitHub** — `src/oneshot/git-host.ts`:
   - Widen `GitHostProvider.openChangeRequest` return to
     `Promise<{ url: string; number: number; headSha: string }>`.
   - In `GithubProvider.openChangeRequest`, widen the response cast to also read
     `number` and `head?: { sha?: unknown }`. Validate `number` is a `number` and
     `head.sha` is a non-empty string; throw a clear `Error` if either is missing
     (same defensive style as the existing `html_url` check). Return all three.
   - Leave the GitLab `providerFor` throw untouched.

3. **Thread through the executor + publish service:**
   - `docker-git-node.ts` `openChangeRequest` (`:426`) — return the widened shape.
   - `src/runner/publish-service.ts` — extend the ok variant to
     `{ ok: true; prUrl: string; prNumber: number; headSha: string }`.
   - `src/oneshot/publish-service.ts` (`:81–91`) — return `prNumber`/`headSha` from the
     `openChangeRequest` result.

4. **Carry repo/number/headSha on the `pr_opened` event** — extend the type in BOTH
   `src/runner/types.ts:20` and `src/sessions/manager.ts:25` to
   `{ type: 'pr_opened'; url: string; repo: string; number: number; headSha: string }`,
   and update both yield sites:
   - `docker.ts:602` — `repo: publishReq.repo, number: publishOutcome.prNumber, headSha: publishOutcome.headSha`.
   - `open-pr.ts` — capture `number`/`headSha` from the `openChangeRequest` call into
     `ctx.prNumber`/`ctx.prHeadSha` (add those to `OneShotContext`), and yield with
     `repo: ctx.repo`.

5. **Write the row when the PR opens** — in the `pr_opened` handler
   (`manager.ts:759`), after the existing `open-pr` audit, call:
   ```ts
   this.store.recordPullRequest({
     session_key: session.key,
     repo: event.repo,
     pr_number: event.number,
     head_sha: event.headSha,
     profile_id: session.profileId,
     opened_at: this.now(),
   });
   ```
   Leave the existing audit event exactly as-is (it stays the completion signal).

## Acceptance criteria

1. `npm run gate` passes — all existing tests stay green, plus the new ones — and
   `npm run boundaries` is clean. **`protocol.ts` is NOT modified** (both copies stay
   byte-identical because you didn't touch them).
2. `SqliteSessionStore.recordPullRequest` → `listOpenPullRequests` round-trips a row
   with the exact field values, `state` defaulting to `'open'` and the nullables null.
   (Pure store test, real `SqliteSessionStore` on a temp/in-memory db, mirroring
   `test/store.test.ts`.)
3. `GithubProvider.openChangeRequest` parses `number` + `head.sha` from a faked fetch
   response and returns `{ url, number, headSha }`; it throws when `number` or `head.sha`
   is missing/wrong-type (mirror the existing `html_url` validation test in the
   git-host tests — use the same fetch-fake seam those tests use).
4. When a `pr_opened` event is handled, the manager writes one `pull_requests` row with
   the event's repo/number/headSha and the session's `profile_id`, `state:'open'`.
   Assert via a `CapturingStore` that captures `recordPullRequest` calls (extend the
   existing fake in `test/manager.test.ts` — add a `recordPullRequest`/`listOpenPullRequests`
   impl and a public array to assert on), driving a `pr_opened` event through the same
   path the existing PR-audit test uses.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste its tail when done.
- **Do NOT touch `src/runner/protocol.ts` or `runner/src/protocol.ts`** — this slice is
  entirely gateway-internal; the `publish_result` wire message is unchanged.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers); required-with-null over
  optional for the new row types (house style); inject nothing new into `SessionManager`
  (it already has `store` and `now`).
- Never log message contents or tokens. The PR url/number/sha are gateway metadata —
  fine to store; do not log them beyond what the existing `open-pr` audit already does.
- Do NOT commit to `main`. Branch is already `codex/0015-s1-pr-tracking`. Implement, get
  the gate green, commit, push, open a PR, and stop at a green reviewable PR — do not merge.

## Out of scope (do NOT build — these are slices 2 and 3)

- Any GitHub **read**/poll, a `getChangeRequestState` provider method, the reconciliation
  timer pass, or a `PrStateReader` seam. (Slice 2.)
- Mutating `state`/`last_polled_at`/`resolved_at` after insert; detecting
  merged/intervened/closed. (Slice 2.)
- The acceptance-rate rollup query. (Slice 3.)
- Adding `profile_id` to `audit_events` (a separate decision for 0016 — this slice puts
  `profile_id` on the `pull_requests` table instead, so 0015 doesn't need it).
- GitLab support.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real, not paraphrased), and confirmation `protocol.ts` was
  not touched (e.g. `git diff --name-only` shows neither copy).
- Any deviation from this spec and why; anything a unit test can't catch.
