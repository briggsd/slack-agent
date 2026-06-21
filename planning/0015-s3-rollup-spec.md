# Task: acceptance-rate rollup over the pull_requests terminal states (0015 — slice 3, final)

You are implementing one slice in this worktree
(`/Users/jedanner/workspace/sa-wt-codex-0015-s3-rollup`, a checkout of the slack-agent
repo — TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` and
`AGENTS.md` first** (gate, invariants, branch+PR workflow), then the context below. You
are already on branch `codex/0015-s3-rollup` — do NOT create a new branch, do NOT commit
to `main`. `node_modules` is symlinked (gate runs offline, no `npm ci`).

## Context — what slices 1 & 2 already shipped (on `main`)

The `pull_requests` table (slice 1) records every opened PR; the reconciliation pass
(slice 2) drives each row to a terminal `state`. The column set:
`id, session_key, team_id (nullable), repo, pr_number, head_sha, profile_id, opened_at,
state, last_polled_at, resolved_at`. `state` values:
- `'open'` — opened, not yet resolved (still in flight).
- `'merged_clean'` — merged with the bot's pushed head intact = **accepted as proposed**.
- `'merged_intervened'` — merged after a human added commits.
- `'closed'` — closed unmerged (rejected).
- `'stale'` — never resolved within the stale window (abandoned).

**This slice is the final one: a read-only rollup** that counts these states over a
rolling window so the flywheel has its acceptance signal. No new external surface, no
protocol, no timer, no manager/wiring change — just store query methods + tests.

## The pattern to mirror (exactly)

The spend-cap rolling-window queries in `src/sessions/store.ts` are your template:
- `SessionStore` interface declarations (`~:136–140`): `sumCostByTask`,
  `sumCostByUserSince(userId, sinceMs)`, `sumCostGlobalSince(sinceMs)`.
- Prepared-statement fields (`~:189–191`) +  their `db.prepare<[...], {...}>(...)`
  assignments (`~:293–303`) + the methods (`~:502–511`, e.g.
  `sumCostByUserSince(userId, sinceMs) { return this.stmtSumByUserSince.get(userId, sinceMs)?.total ?? 0; }`).
- `NoopSessionStore` no-op stubs (`~:545–547`, return `0`).

Your new methods differ in one way: they aggregate **grouped counts** (`GROUP BY state`),
so the prepared statement returns multiple rows and you use `.all()` (not `.get()`), then
reduce the rows into the result object.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until fully implemented AND `npm run gate` passes.
Make every edit, add tests, run the gate, fix failures, then stop.

## What to build (all in `src/sessions/store.ts`)

1. **`AcceptanceStats` interface** (export it):
   ```ts
   export interface AcceptanceStats {
     opened: number;            // total PRs opened in the window (all states)
     mergedClean: number;       // accepted as proposed
     mergedIntervened: number;
     closed: number;
     stale: number;
     stillOpen: number;         // state 'open' — not yet resolved
     resolved: number;          // mergedClean + mergedIntervened + closed + stale
     acceptanceRate: number | null; // mergedClean / resolved; null when resolved === 0
   }
   ```

2. **Two query methods** (declare on `SessionStore`, implement on `SqliteSessionStore`,
   no-op on `NoopSessionStore` returning an all-zero stats object with
   `acceptanceRate: null`). Both **window on `opened_at >= sinceMs`** (PRs opened in the
   window — a coherent single window; document this choice):
   - `acceptanceStatsGlobalSince(sinceMs: number): AcceptanceStats`
   - `acceptanceStatsByTeamSince(teamId: string, sinceMs: number): AcceptanceStats`
     — adds `AND team_id = ?`. **This is the tenancy-scoped variant** any user-facing
     consumer must use (the `listOpenPullRequests` doc comment already flags that
     pull_requests data must be team-scoped before it reaches a user). Document that the
     `Global` variant is operator-only.

   Implementation shape (mirror, with grouped `.all()`):
   ```ts
   this.stmtAcceptanceGlobalSince = this.db.prepare<[number], { state: string; n: number }>(
     'SELECT state, COUNT(*) AS n FROM pull_requests WHERE opened_at >= ? GROUP BY state',
   );
   // method: reduce the rows into AcceptanceStats (see the helper below).
   ```
   Write a single private helper that turns the grouped rows into `AcceptanceStats`
   (sum the per-state counts, compute `opened`/`resolved`/`acceptanceRate`) so both
   methods share it. `acceptanceRate = resolved === 0 ? null : mergedClean / resolved`.
   An unknown/unexpected `state` value must not throw — count it toward `opened` only
   (defensive: a future state shouldn't break the rollup).

## Acceptance criteria

1. `npm run gate` passes (existing tests stay green, plus the new ones);
   `npm run boundaries` clean. **Do NOT touch `protocol.ts`.**
2. New `test/store.test.ts` cases on a real `SqliteSessionStore` (mirror the existing
   spend-cap rolling-window tests' style):
   - Seed `pull_requests` rows across all five states (use `recordPullRequest` then
     `resolvePullRequest` to set terminal states, exactly as slice 2 does), some inside
     and some **before** the window (`opened_at < sinceMs`, which must be excluded).
     Assert `acceptanceStatsGlobalSince` returns the right per-state counts, `opened`,
     `resolved`, and `acceptanceRate` (= mergedClean / resolved).
   - `acceptanceRate` is `null` when no PR has resolved (only `open` rows in window).
   - `acceptanceStatsByTeamSince` isolates one team's rows (seed two teams; assert the
     other team's PRs are excluded).
   - A row with an unexpected `state` string counts toward `opened` but not toward any
     resolved bucket and does not throw.

## Hard constraints (do NOT violate)

- The gate must pass; paste its tail. **Do NOT modify `protocol.ts`** (either copy).
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers). Pure SQL/reduce — no new
  deps, no network, no timers.
- Read-only: do not change the table schema, the reconciliation, or any write path. This
  slice only adds query methods + tests.
- Do NOT commit to `main`. Implement on `codex/0015-s3-rollup`, get the gate green,
  commit, push, open a PR, stop at a green reviewable PR — do not merge.

## Out of scope (do NOT build)

- Any user-facing surface (Slack command, etc.) that exposes the rate — there is no
  consumer yet by design; this slice provides the query primitive. (A future slice wires
  it up.)
- A profile-scoped variant (that's for the 0016 circuit breaker), per-user variants,
  webhooks, or windowing on `resolved_at`.
- Touching the manager, app.ts, or index.ts — no wiring needed.

## When done — report precisely (REAL output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real), and confirm `git diff --name-only` shows neither
  `protocol.ts` copy.
- Any deviation from this spec and why.
