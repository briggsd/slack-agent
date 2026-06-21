# Task: reconcile open PRs to a terminal state (0015 acceptance metric — slice 2)

You are implementing one slice in this worktree
(`/Users/jedanner/workspace/sa-wt-codex-0015-s2-reconciliation`, a checkout of the
slack-agent repo — TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` and `AGENTS.md` first** (gate, invariants, branch+PR workflow), then the
context below. You are already on branch `codex/0015-s2-reconciliation` — do NOT
create a new branch, do NOT commit to `main`. `node_modules` is symlinked (gate runs
offline, no `npm ci`).

## Context — what slice 1 already shipped (read it; don't redo it)

Slice 1 (already on `main`) records every opened PR into a `pull_requests` table:
columns `id, session_key, team_id, repo, pr_number, head_sha, profile_id, opened_at,
state ('open' default), last_polled_at (null), resolved_at (null)`, plus
`store.recordPullRequest(...)` and `store.listOpenPullRequests(): PullRequestRow[]`
(the worklist). `head_sha` is the sha the bot pushed.

**This slice adds the reconciliation:** a periodic pass that polls each open PR's real
state on GitHub and drives the row to a terminal state. **Intervention is detected by
SHA, not author** (the bot and a human reviewer share the publishing identity, so
authorship can't distinguish them): a merged PR whose current branch head still equals
the recorded `head_sha` was accepted **as proposed** (`merged_clean`); a merged PR whose
head moved past it had human commits added (`merged_intervened`).

## Grounded seams (freshly checked — verify, line numbers may drift slightly)

- **`GitHostProvider` / `GithubProvider`** — `src/oneshot/git-host.ts`: the interface
  (`~:30–49`) and `GithubProvider` (`~:84–130`). `openChangeRequest` (slice 1) already
  does an authed `req.fetchFn(url, {...})` to `api.github.com` with `Authorization:
  Bearer ${token}` and parses `res.json()` defensively (throws on missing/typed-wrong
  fields). Mirror that exact style for the new read. `providerFor` (`~:135`) returns a
  `GithubProvider` for `'github'` and **throws** for `'gitlab'` — leave that.
- **Credential lease** — `src/broker/bot-account.ts` `lease(req)` (`~:26`) returns a
  `CredentialLease { token, host, repo, revoke() }` (`src/broker/types.ts:18`); `revoke()`
  is a no-op for the static token but **always call it in a `finally`**. `CredentialBroker`
  is the injected interface (`src/broker/types.ts`). The `fetchFn` type is `FetchFn`
  (exported from `src/oneshot/git-host.ts`); default to global `fetch`.
- **SessionManager** — `src/sessions/manager.ts`: constructor opts object (`~:126`),
  optional-dependency injection pattern (`volumeReaper?`), the GC timer block
  (`~:168–178`: `if (this.volumeReaper !== undefined) { const timer = setInterval(() =>
  void this.runVolumeGc(), this.gcIntervalMs); ...unref()...; this.gcTimer = timer; }`),
  `runVolumeGc()` (`~:1166`, reentrancy via a `gcRunning` flag), the injected clock
  `this.now()` (`~:163`), and the `audit()` helper. Mirror the timer + reentrancy + clock
  patterns exactly.
- **Wiring** — `buildGateway` (`src/app.ts:34`) builds the `SessionManager` and forwards
  optional deps (`GatewayDeps` `~:20–33`; spread-forwarded `~:35–47`). `index.ts`
  constructs `broker`/`gitNodes` in the real-backend branch (`~:105–117`) and calls
  `buildGateway({...})` (`~:146–161`). The fake backend (`~:139–140`) injects neither —
  reconciliation stays off there (like `volumeReaper`).
- **`PullRequestRow`** and the store interface/`SqliteSessionStore`/`NoopSessionStore`
  are in `src/sessions/store.ts` (slice 1). The `recordSession`/`recordAudit` prepared-
  statement pattern (`db.prepare<[...]>(...)` field + a method calling `.run(...)`) is the
  one to mirror for the new UPDATE statements.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until fully implemented AND `npm run gate` passes.
Make every edit, add tests, run the gate, fix failures, then stop.

## What to build

1. **`getChangeRequestState` on the git-host provider** — `src/oneshot/git-host.ts`:
   - Add to `GitHostProvider`:
     `getChangeRequestState(req: { repo: string; number: number; token: string; fetchFn: FetchFn }): Promise<{ status: 'open' | 'merged' | 'closed'; headSha: string }>`.
   - `GithubProvider` impl: `GET https://api.github.com/repos/${repo}/pulls/${number}`
     with the same Bearer auth + `Accept: application/vnd.github+json` headers as
     `openChangeRequest`. Parse defensively (cast to a narrow shape, validate types,
     throw a clear `Error` on a non-OK response or missing fields, mirroring the existing
     `openChangeRequest` validation). Map the response:
     `merged === true` → `'merged'`; else `state === 'closed'` → `'closed'`; else `'open'`.
     `headSha` = `head.sha` (validate non-empty string).
   - No GitLab impl (only `GithubProvider` exists; `providerFor('gitlab')` already throws).

2. **`PrStateReader` seam** — new interface in `src/sessions/pr-state-reader.ts`:
   ```ts
   export interface PrState { status: 'open' | 'merged' | 'closed'; headSha: string; }
   export interface PrStateReader {
     getState(req: { repo: string; number: number }): Promise<PrState>;
   }
   ```
   And `RealPrStateReader` in `src/oneshot/pr-state-reader.ts` implementing it:
   constructor `(broker: CredentialBroker, fetchFn: FetchFn = fetch)`. `getState`: lease a
   token (`broker.lease({ host: 'github', repo })`), call
   `providerFor('github').getChangeRequestState({ repo, number, token: lease.token, fetchFn })`,
   and **`revoke()` in a `finally`**. v1 is github-only — add a one-line comment that a
   multi-host version would need a `host` column on `pull_requests`.

3. **Store mutators + a diagnostic getter** — `src/sessions/store.ts`, mirroring the
   slice-1 prepared-statement style; add to the `SessionStore` interface and no-ops to
   `NoopSessionStore`:
   - `resolvePullRequest(id: number, state: string, resolvedAtMs: number): void` —
     `UPDATE pull_requests SET state = ?, resolved_at = ?, last_polled_at = ? WHERE id = ?`
     (set `last_polled_at` to the same `resolvedAtMs`). The terminal states are
     `'merged_clean' | 'merged_intervened' | 'closed' | 'stale'`.
   - `touchPullRequestPolled(id: number, polledAtMs: number): void` —
     `UPDATE pull_requests SET last_polled_at = ? WHERE id = ?` (PR still open).
   - `getPullRequest(id: number): PullRequestRow | undefined` — `SELECT * ... WHERE id = ?`.
     Test/diagnostic helper; add the same "NOT tenancy-scoped" caveat comment style used
     on `getAuditEvents`/`listOpenPullRequests`.

4. **Reconciliation pass in `SessionManager`** — `src/sessions/manager.ts`:
   - Constructor opts: add `prStateReader?: PrStateReader` and
     `prStaleAfterMs?: number` (default `30 * 24 * 60 * 60 * 1000`). Store them as fields;
     reuse the existing `gcIntervalMs` for cadence.
   - Start a **sibling timer**, gated on `prStateReader`, mirroring the GC timer block
     (`setInterval(() => void this.runPrReconciliation(), this.gcIntervalMs)`, `.unref()`,
     keep a handle). Do NOT touch the existing GC timer.
   - `async runPrReconciliation(): Promise<void>` with a reentrancy guard (a
     `prReconcileRunning` flag, like `gcRunning`):
     - `const rows = this.store.listOpenPullRequests();`
     - For each row, in a **try/catch so one failing poll doesn't abort the sweep** (log
       `repo#pr_number` + the error message only — never tokens/content; leave the row
       open for the next tick on error):
       - If `this.now() - row.opened_at > this.prStaleAfterMs` →
         `this.store.resolvePullRequest(row.id, 'stale', this.now())`; continue (stop
         polling abandoned PRs).
       - Else `const st = await this.prStateReader.getState({ repo: row.repo, number: row.pr_number })`.
         - `st.status === 'merged'` → state =
           `st.headSha === row.head_sha ? 'merged_clean' : 'merged_intervened'`;
           `resolvePullRequest(row.id, state, this.now())`.
         - `st.status === 'closed'` → `resolvePullRequest(row.id, 'closed', this.now())`.
         - `st.status === 'open'` → `touchPullRequestPolled(row.id, this.now())`.
   - Cleanup: clear the new timer wherever the GC timer is cleared (find `clearInterval`
     for `gcTimer` and mirror it, so `dispose`/shutdown stops both).

5. **Wire it through** — `src/app.ts`: add `prStateReader?: PrStateReader` to `GatewayDeps`
   and spread-forward it into the `SessionManager` opts (same `...(deps.x !== undefined &&
   { x: deps.x })` pattern). `src/index.ts`: in the **real-backend branch**, construct
   `const prStateReader = new RealPrStateReader(broker);` and pass `prStateReader` to
   `buildGateway(...)`. Do not wire it in the fake-backend branch.

## Acceptance criteria

1. `npm run gate` passes (all existing tests stay green, plus new ones); `npm run
   boundaries` clean. **Do NOT touch `protocol.ts`** (either copy) — this slice is
   gateway-internal.
2. `GithubProvider.getChangeRequestState` maps a faked fetch response correctly for all
   three statuses (merged / closed-unmerged / open) and returns `head.sha`; throws on a
   non-OK response and on a missing `head.sha` (mirror the existing `openChangeRequest`
   git-host tests + their fetch-fake seam).
3. Store: `resolvePullRequest` moves a row out of `listOpenPullRequests` and sets
   `state`/`resolved_at`/`last_polled_at` (verify via `getPullRequest`);
   `touchPullRequestPolled` updates `last_polled_at` while the row stays open. (Real
   `SqliteSessionStore`, mirroring `test/store.test.ts`.)
4. `SessionManager.runPrReconciliation` with a **fake `PrStateReader`** and a
   `CapturingStore`-style fake (extend the existing test fake to support the open-PR
   worklist + the mutators, asserting on the resulting rows) covers: merged+same-sha →
   `merged_clean`; merged+different-sha → `merged_intervened`; closed → `closed`; still
   open → stays open with `last_polled_at` updated; `opened_at` older than
   `prStaleAfterMs` → `stale` (and the reader is NOT called for the stale row); a reader
   that throws on one row leaves it open and still processes the others. Use the injected
   `now()` for deterministic windows (no real timers — call `runPrReconciliation()`
   directly, like the `runVolumeGc()` tests).

## Hard constraints (do NOT violate)

- The gate must pass; paste its tail. **Do NOT modify `protocol.ts`.**
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` specifiers). Inject dependencies; tests
  use fakes (a fake `PrStateReader`, the existing store/broker fakes) — **no real network,
  Docker, or timers**.
- Reuse the credential lease + `fetchFn` machinery; the reconciliation token stays on the
  gateway and is **never logged** (log only `repo#number` + lifecycle/error text).
- Respect the boundary invariants (`npm run boundaries`): no new cross-package imports; the
  gateway never imports the `runner/` package or the Agent SDK. `src/oneshot` may import the
  `PrStateReader` interface from `src/sessions`; `SessionManager` imports only the interface.
- Do NOT commit to `main`. Implement on `codex/0015-s2-reconciliation`, get the gate green,
  commit, push, open a PR, stop at a green reviewable PR — do not merge.

## Out of scope (do NOT build)

- The acceptance-rate **rollup** query/store method and any user-facing surface. (Slice 3.)
- A circuit breaker (0016), any audit-event mirror of the terminal state (the
  `pull_requests` row IS the record for now), polling backoff beyond `last_polled_at`,
  webhooks (poll only), GitLab, or a `host` column on `pull_requests`.

## When done — report precisely (REAL output)

- What changed, file by file (one line each).
- The tail of `npm run gate` (real), and confirm `git diff --name-only` shows neither
  `protocol.ts` copy.
- Any deviation from this spec and why; anything a unit test can't catch (e.g. not run
  against live GitHub — say so).
