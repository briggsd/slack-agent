# Task: wire an operator grant path for `exec` opt-in (`EXEC_OPT_IN_USERS`, reconciled at startup)

You are implementing one slice in this worktree (TypeScript, Node 20+, ESM, vitest,
strict tsc). **Read the root `CLAUDE.md` first** (gate, invariants, conventions), then the
context below. You are on branch `sonnet/ece69b-exec-opt-in-grant`. Tracks `track ece69b`.

## Context — the gap

The gateway already has the opt-in *check* for the un-gated `exec` one-shot path:
`SessionManager.runExec` refuses unless `store.hasExecOptIn(teamId, actor)` is true
(`src/sessions/manager.ts:1029`, `:1075`), backed by the `exec_opt_ins` table
(`team_id, user_id, granted_at`, PK `(team_id, user_id)` — `src/sessions/store.ts:518`).
But **`store.recordExecOptIn` has no production caller** — nothing in `src/` records an
opt-in — so in production `hasExecOptIn` is always false and `exec` is always refused. The
intent (S14, `planning/m6-conversational-planning-slices.md:106`) is that the opt-in is
**gateway state set by an operator, not inferred from chat**.

This slice adds the operator grant surface: an env allowlist `EXEC_OPT_IN_USERS`, parsed
exactly like `CLONE_REPO_ALLOWLIST` and **reconciled into the table at startup** — the env
is the single source of truth, so removing a user and restarting revokes them.

`CLONE_REPO_ALLOWLIST` is your precedent at every layer:
`parseRepoAllowlist` (`src/config.ts:164`), the `Config` field (`cloneRepoAllowlist`,
`config.ts:89`), the assembly call (`config.ts:320`), and how `index.ts` reads config and
builds the store (`src/index.ts:80-81`).

## CRITICAL — do not stop after exploration

Do NOT pause or yield until implemented AND `npm run gate` passes. Make every edit, add
tests, run the gate, fix failures, then stop. Zero-file-change yield is a failure.

## The change, layer by layer

### 1. `src/config.ts` — parse `EXEC_OPT_IN_USERS`

Add an exported `parseExecOptInUsers(raw: string | undefined):
ReadonlyArray<{ teamId: string; userId: string }>`, mirroring `parseRepoAllowlist`'s
strict, fail-startup style:
- `undefined`/blank → `[]`.
- Split on `,`; trim each; skip empties.
- Each entry is `TEAM:USER` — exactly one `:`, with non-empty team and user and no
  whitespace. Validate with a single regex (e.g. `/^[^\s:]+:[^\s:]+$/`); on failure throw
  `Invalid EXEC_OPT_IN_USERS entry "<entry>": expected TEAM:USER (Slack team + user id)`.
  Do NOT enforce Slack `T…`/`U…` prefixes (tests use ids like `TEAM`/`U-REQ`).
- Split each valid entry into `{ teamId, userId }`. De-duplicate (a repeated pair is not an
  error; collapse it).
Add a `Config` field `execOptInUsers: ReadonlyArray<{ teamId: string; userId: string }>`
(top-level, next to where session policy lives — NOT inside `oneshot`/`docker`). Parse it in
the assembly (`const execOptInUsers = parseExecOptInUsers(process.env['EXEC_OPT_IN_USERS']);`)
and add it to the returned config object.

### 2. `src/sessions/store.ts` — a reconcile method

Add to the `SessionStore` interface (near `recordExecOptIn`, `:193`):
```ts
/** Reconcile the exec opt-in set to EXACTLY these (team,user) pairs: grant the listed,
 *  revoke everyone else. Atomic. The operator allowlist is the single source of truth. */
replaceExecOptIns(entries: ReadonlyArray<{ teamId: string; userId: string }>, atMs: number): void;
```
Implement on `SqliteSessionStore`: a `better-sqlite3` transaction that `DELETE FROM
exec_opt_ins` then inserts each entry (reuse the existing record statement, or a prepared
INSERT). Wrap the delete+inserts in `this.db.transaction(...)` so a partial apply can't
leave the table half-updated. Prepare any new statement in the constructor alongside
`stmtRecordExecOptIn`.

Add a no-op `replaceExecOptIns` to the in-memory/no-op store in the same file (the one with
the no-op `recordExecOptIn` at `:743`).

### 3. `src/index.ts` — reconcile at startup

Right after the store is constructed (`src/index.ts:81`) and before the manager is built,
reconcile:
```ts
store.replaceExecOptIns(config.execOptInUsers, Date.now());
console.log(`[gateway] exec opt-in: ${config.execOptInUsers.length} user(s) granted`);
```
Log the **count only** — never the team/user ids in the log line (operator config, but keep
logs metadata-only per the house rule). `Date.now()` is fine here (this is `index.ts`, the
real entrypoint, not tested code).

### 4. Tests

- **`test/config.test.ts`** — `parseExecOptInUsers`: a well-formed `T1:U1,T1:U2` → two pairs;
  whitespace/empty segments tolerated; a duplicate pair collapses; `undefined`/`''` → `[]`;
  malformed entries throw (`U1` no colon; `:U1` empty team; `T1:` empty user; `T1:U1:x`
  extra colon; an entry with whitespace). Mirror the existing `parseRepoAllowlist` tests.
- **`test/store.test.ts`** — `replaceExecOptIns` reconcile semantics on a real
  `SqliteSessionStore` (the suite already builds one): start empty; replace with
  `[{T,U1},{T,U2}]` → `hasExecOptIn` true for both; replace with `[{T,U2},{T,U3}]` → U1 now
  false, U2 still true, U3 true (revoke + grant in one call); replace with `[]` → all false.
  Confirm it is one atomic call (no partial state visible after).
- **`test/manager.test.ts`** — the existing exec opt-in tests already cover refuse/allow.
  You ONLY need to add the new `replaceExecOptIns` method to the test store(s) that
  `implements SessionStore` (the `CapturingStore` near `:146` / `:1056`) so they still
  satisfy the interface — a minimal in-memory implementation that the existing
  `recordExecOptIn`/`hasExecOptIn` test doubles can share. Do not change existing test
  behavior.

### 5. Docs (this worktree's copies)

- **`.env.example`** — add an `EXEC_OPT_IN_USERS` block in the one-shot section, e.g.:
  ```
  # Users allowed to run the un-gated `exec` one-shot (the gated `task` needs no opt-in).
  # Comma-separated TEAM:USER (Slack workspace id + user id). Reconciled at startup: this
  # list is the full source of truth, so removing a user and restarting revokes them.
  # Unset/empty = nobody may exec.
  # EXEC_OPT_IN_USERS=T0123ABCD:U0123WXYZ
  ```
- **`README.md`** — add `EXEC_OPT_IN_USERS` to the docker env table, and in the
  "One-shot repo tasks" section note that `exec` is refused until an operator lists the user
  in `EXEC_OPT_IN_USERS` (`task` is unaffected). Keep it short and accurate.

## Acceptance criteria

1. `npm run gate` passes; test count rises.
2. With `EXEC_OPT_IN_USERS=T:U1,T:U2` set, a fresh gateway boot records exactly those opt-ins
   (and revokes any not listed); `hasExecOptIn('T','U1')` is true, an unlisted user is false.
3. A malformed `EXEC_OPT_IN_USERS` entry fails startup (thrown from config parsing), matching
   the `CLONE_REPO_ALLOWLIST` fail-closed behavior.
4. `replaceExecOptIns` is atomic and reconciles (grant listed + revoke unlisted) in one call.
5. No change to the `exec_opt_ins` schema, the `runExec` check, or chat-driven paths — the
   opt-in stays gateway state set only by the operator allowlist.

## Hard constraints (do NOT violate)

- `npm run gate` must pass; paste the **real tail** (pass/fail counts) + `git diff --stat`.
- No `any`, no `@ts-ignore`, no non-null `!`. `NodeNext` ESM; honor `exactOptionalPropertyTypes`.
- Logs carry the opt-in COUNT only, never team/user ids or any message content/token.
- Do NOT add runtime deps. Do NOT commit. Do NOT `git add -A`. (The spec is already committed
  as the branch's first commit.)

## Out of scope

- Any chat/Slack command to grant opt-in (intentionally operator-only, not chat-driven).
- A CLI/admin tool, a Slack admin slash command, or channel/profile-based permission models.
- Changing how `runExec` checks the opt-in, or the `exec`/`task` parse/trigger.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each), incl. test + doc files.
- Real tail of `npm run gate` (pass/fail counts) + `git diff --stat`.
- State old vs new test count.
- Any deviation from this spec and why.
