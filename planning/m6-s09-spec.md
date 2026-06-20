# Task: spend-caps Slice B1 — enforce the three rolling dollar caps

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m6-s09-spend-caps-enforcement`, working in this worktree. **Do NOT edit this
spec.**

## Context — read before writing code

Slices A (#37) and B0 (#38) shipped: every turn's cost is recorded to `audit_events`
(`cost_micro_usd`, `kind:'cost'` rows), the ledger is durable + indexed
(`audit_by_user_ts (user_id, ts)`, `audit_by_ts (ts)`), and the container-supplied
fields are coerced to non-negative integers at the `docker.ts` boundary. **This slice
turns the ledger into enforcement.** It is gateway-only — no runner or protocol change.

The full policy was grilled to a decision; the **exact decisions are inlined below** —
follow them, don't re-derive. Code you build on (post-B0 line numbers; re-grep to be
sure):
- `src/config.ts` — `Config` interface (~109) + `loadConfig()` (~126); `optionalEnvNumber`
  helper (~9).
- `src/sessions/store.ts` — `SessionStore` interface (~67), `SqliteSessionStore`
  (prepared statements ~133–190, the `audit_events` indexes from B0), `NoopSessionStore`
  (~338).
- `src/sessions/manager.ts` — `SessionManager` constructor/opts (~60–95), `Session`
  type (~20), `QueueItem` (~11, has optional `userId`), `enqueueNew` (~169),
  `enqueueExisting` (~183, note its three internal paths: parked-approval gate reply,
  normal in-memory hit ~254, and the rehydrate path ~271), the `drain` loop
  (~332, the `while (session.queue.length > 0)` body), the `audit()` helper (~579).
- `src/index.ts` — wires `Config` into `new SessionManager(...)`.
- `test/manager.test.ts` — `CapturingStore` fake (~682) and the manager test patterns
  (`FakeRunnerFactory`, scripted `usage` events from Slice A).

## CRITICAL — do not stop after exploration

Implement end to end: every edit, the tests, `npm run gate`, fix failures, then stop.
Yielding after only exploring is a failure.

## The decisions (inlined — implement exactly these)

- **Accounting = overage-by-one-turn.** Check *accumulated* spend before dispatching a
  turn; the breaching turn (already billed) completes, the *next* is refused. The cap is
  a "stop once accumulated ≥ cap" floor, not a hard never-exceed ceiling.
- **Caps (all in integer micro-USD; `0` = that cap disabled):**
  - per-task = lifetime `SUM(cost_micro_usd)` for the session.
  - per-user-24h = `SUM … WHERE user_id=? AND ts > now-24h`.
  - global-24h = `SUM … WHERE ts > now-24h`.
- **Breach test is `>=`** (accumulated at-or-over the cap → refuse the next turn).
- **`now` is injected** into `SessionManager` (default `() => Date.now()`), so the 24h
  windows are testable offline. 24h = `24 * 60 * 60 * 1000`.
- **Per-user is keyed on `session.requestorUserId`** (matches Slice A's cost attribution
  — every cost row is attributed to the requestor). At `enqueueNew`, the would-be
  requestor is `item.userId`. **Unknown user (`undefined`) → skip the per-user check;
  per-task + global still apply.**

### 1. Config — three env knobs (`src/config.ts`)

Add a `spendCaps` block to `Config` and `loadConfig()`. Parse dollars → integer
micro-USD; `unset → generous default`; explicit `0 → 0` (disabled); clamp negatives to 0.

```ts
// in Config:
spendCaps: {
  /** Lifetime per-session cap, micro-USD. 0 = disabled. */
  perTaskMicroUsd: number;
  /** Rolling-24h per-user cap, micro-USD. 0 = disabled. */
  perUser24hMicroUsd: number;
  /** Rolling-24h workspace-wide cap, micro-USD. 0 = disabled. */
  perGlobal24hMicroUsd: number;
};
```

In `loadConfig()` — a small helper, dollars→micro-USD, generous defaults:

```ts
const usdToMicro = (usd: number): number => Math.max(0, Math.round(usd * 1_000_000));
// …
spendCaps: {
  perTaskMicroUsd:     usdToMicro(optionalEnvNumber('SPEND_CAP_PER_TASK_USD', 20)),
  perUser24hMicroUsd:  usdToMicro(optionalEnvNumber('SPEND_CAP_PER_USER_24H_USD', 100)),
  perGlobal24hMicroUsd: usdToMicro(optionalEnvNumber('SPEND_CAP_GLOBAL_24H_USD', 400)),
},
```

### 2. Store — three SUM methods (`src/sessions/store.ts`)

Add to the `SessionStore` interface, `SqliteSessionStore` (prepared statements, riding
the B0 indexes), and `NoopSessionStore` (return `0` — Noop never enforces). Mirror them
in `CapturingStore` in the tests (compute from in-memory `audits[]`).

```ts
// SessionStore interface:
/** Σ cost_micro_usd for a session (lifetime). 0 when none. */
sumCostByTask(sessionKey: string): number;
/** Σ cost_micro_usd for a user since `sinceMs` (rolling window). 0 when none. */
sumCostByUserSince(userId: string, sinceMs: number): number;
/** Σ cost_micro_usd across all sessions since `sinceMs`. 0 when none. */
sumCostGlobalSince(sinceMs: number): number;
```

SQLite — use `COALESCE(SUM(cost_micro_usd), 0)` so the empty case is `0`, and read the
single value out as a `number`:

```sql
SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE session_key = ?
SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE user_id = ? AND ts > ?
SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM audit_events WHERE ts > ?
```

Type the prepared statement result (e.g. `Database.Statement<[...], { total: number }>`);
no `any`. `kind` is intentionally NOT filtered — only `kind:'cost'` rows have a non-null
`cost_micro_usd`, so the `SUM` is already correct and stays index-friendly.

### 3. Per-turn sanity clamp (`src/runner/docker.ts`) — finishes B0's deferred CRITICAL

Cap each turn's *recorded cost* at a hardcoded ceiling so a compromised sandbox can't
poison the ledger / overflow the `SUM`. Add a module constant and clamp `costMicroUsd`
in the existing `usage` dispatch branch (the one that already calls `toCount(...)`):

```ts
/** Anti-poison ceiling on a single turn's recorded cost (micro-USD, ~$20). Far above any
 *  real turn; a value past it is a misreport, so we clamp rather than trust it. NOT a
 *  policy knob — the configurable caps live in the gateway. */
const PER_TURN_COST_CEILING_MICRO_USD = 20_000_000;
// …
costMicroUsd: Math.min(toCount(parsed.costMicroUsd), PER_TURN_COST_CEILING_MICRO_USD),
```

Only `costMicroUsd` is clamped (it feeds the dollar caps). The token fields stay as
`toCount(...)` — they're informational and not summed for enforcement.

### 4. Manager — caps + clock + `checkCaps` + the two seams (`src/sessions/manager.ts`)

**Constructor opts:** add `spendCaps: { perTaskMicroUsd; perUser24hMicroUsd;
perGlobal24hMicroUsd }` and `now?: () => number` (default `() => Date.now()`). Store both
on the instance. Existing tests construct `SessionManager` without these — make
`spendCaps` optional with an all-zero (disabled) default so current tests are unaffected.

**The helper:**

```ts
private checkCaps(sessionKey: string, userId: string | undefined): 'task' | 'user' | 'global' | null {
  const caps = this.spendCaps;
  if (caps.perTaskMicroUsd > 0 && this.store.sumCostByTask(sessionKey) >= caps.perTaskMicroUsd) {
    return 'task';
  }
  if (caps.perUser24hMicroUsd > 0 && userId !== undefined) {
    const since = this.now() - 24 * 60 * 60 * 1000;
    if (this.store.sumCostByUserSince(userId, since) >= caps.perUser24hMicroUsd) return 'user';
  }
  if (caps.perGlobal24hMicroUsd > 0) {
    const since = this.now() - 24 * 60 * 60 * 1000;
    if (this.store.sumCostGlobalSince(since) >= caps.perGlobal24hMicroUsd) return 'global';
  }
  return null;
}
```

**Admission (hard reject).** Check at the start of `enqueueNew` (before `getOrCreate`),
and in `enqueueExisting` on the **normal in-memory hit** path and the **rehydrate** path
(both enqueue a new billable turn) — NOT on the parked-approval gate-reply path (resolving
a gate isn't a new turn; the drain check backstops continued spend). On a breach:
- post an honest message to the thread (see §5),
- record a `correction` audit row (see §6),
- return without enqueuing (for `enqueueNew`: do not `getOrCreate`, so no container spins
  up; for `enqueueExisting`: return `true` — the message *was* handled, the thread is
  known; do not push/drain).

For `enqueueNew` use `item.userId`; for `enqueueExisting` use `session.requestorUserId`.

**Mid-task (graceful stop, pre-dispatch).** At the **top of the `while (session.queue.length
> 0)` body in `drain`**, after `shift()`-ing the item and before `postPlaceholder`/`send`,
call `checkCaps(session.key, session.requestorUserId)`. On a breach:
- post the honest "stopped on budget" message (§5) to `item.channel`/`item.threadTs`,
- record a `correction` audit row (§6),
- `session.queue.length = 0` (drop any further queued turns — the session is over budget),
- `break` out of the `while` loop.

Note: because the check is **pre-dispatch**, no turn is interrupted mid-flight — the prior
turn already completed and released its own resources (lease, etc.). So this does NOT need
`iterator.return()`/0006's lease-revoke; it simply declines to start the next turn. (It
reuses the abandoned *UX*, not that mechanism.)

### 5. Honest Slack messages (metadata only — never message content)

Show the limit (config, not content) and, for the rolling caps, the user's own current
24h spend. Rolling-window language, **no false-precise countdown**. Format dollars from
micro-USD (e.g. `$${(micro/1e6).toFixed(2)}`). Suggested text:
- per-task (admission or mid-task): `:no_entry_sign: This thread reached its budget
  ($20.00) — nothing was pushed. Start a new thread to continue.`
- per-user: `:no_entry_sign: You've reached your daily spend limit ($100.00 / 24h; you're
  at $X). It frees up gradually as usage ages out — try again later.`
- global: `:no_entry_sign: The workspace daily spend limit ($400.00 / 24h) is reached —
  try again later.`

Admission rejects post a NEW threaded message (`slack.postMessage`); mid-task uses the
placeholder if one exists, else posts to the thread (mirror the existing abandon handler's
posting style ~404). The global message must not reveal other users' specifics.

### 6. Audit the enforcement action

Record via the existing `this.audit({...})` helper: `kind: 'correction'`,
`tool: 'spend-cap'`, `result` = `` `${action}:${cap}` `` where action is `rejected`
(admission) or `abandoned` (mid-task) and cap is `task|user|global` (e.g.
`'rejected:user'`, `'abandoned:task'`). Attribute `session_key`/`team_id`/`user_id` like
the other audit calls. Metadata only — no message text.

### 7. Wire it (`src/index.ts`)

Pass `spendCaps: config.spendCaps` into `new SessionManager(...)`. Leave `now` to its
default (real clock) in production. Re-grep `index.ts` for the construction site.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the new ones).
2. With caps configured, a `SUM`-over-ledger breach **rejects at admission**
   (`enqueueNew`/`enqueueExisting`): no turn enqueued, an honest message posted, a
   `correction`/`spend-cap` audit row recorded.
3. A session that crosses a cap mid-run is **stopped pre-dispatch on the next turn**:
   message posted, queue cleared, `correction`/`spend-cap` row recorded, no further turns.
4. All three caps enforce (per-task lifetime, per-user-24h, global-24h) with the injected
   clock; `0` disables a cap; unknown `user_id` skips per-user but per-task/global still
   apply.
5. A turn reporting cost above the per-turn ceiling is recorded clamped to it.
6. Default `SessionManager` (no `spendCaps`) and existing tests are unaffected (caps
   default to disabled).

### New tests (offline — fakes only; no network/Slack/Docker/API)

- **`test/store.test.ts`** — round-trip the three sum methods: record several `kind:'cost'`
  rows (varied `session_key`/`user_id`/`ts`) and assert `sumCostByTask`,
  `sumCostByUserSince(userId, since)` (window boundary: a row at `ts <= since` is excluded),
  and `sumCostGlobalSince` return the right integer sums; empty → `0`.
- **`test/manager.test.ts`** — use `FakeRunnerFactory` + a `CapturingStore` extended with
  the three sum methods (compute from `audits[]`), and an injected `now`. Cover:
  - admission reject on per-user and on global (message posted, no drain, `rejected:<cap>`
    audit row); per-task reject on a continuing thread.
  - mid-task abandon: script turns whose `usage` accumulates past the per-task cap, assert
    the next turn is refused (`abandoned:task` row, queue cleared, "nothing was pushed"
    message).
  - `0`-disabled cap is not enforced; unknown `userId` skips per-user (global still trips).
  - clock: a per-user row older than 24h (via injected `now`) does NOT count.
  - no cost value or message content leaks into any audit row (metadata only).
- **`test/docker.test.ts`** — a `usage` line with `costMicroUsd` above the ceiling is
  yielded clamped to `PER_TURN_COST_CEILING_MICRO_USD`; a normal value passes through.
- **`test/config.test.ts`** (if present, else fold into an existing config test) — the
  three env vars parse dollars→micro-USD; unset → defaults; `0` → 0; negative → 0.

## Hard constraints

- Gate (`npm run gate`) must pass; paste the **tail** (with test counts) when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM; inject deps in tests (`now`, store, factory).
- **Gateway-only:** no runner/protocol change, no new RunnerEvent, no Bolt import outside
  `index.ts`, no Agent SDK / `runner/` import in the gateway (boundary-enforced).
- Never log or post message contents or tokens; cost numbers shown to the user are
  aggregate dollars only.
- A store hiccup must not crash a turn — the existing audit/touch calls already swallow
  store errors; if a `SUM` query throws, fail **open** (treat as under-cap) and log
  metadata only, so a transient DB error never wedges the bot. (Match the existing
  best-effort pattern around `store.touch`/`recordAudit`.)
- Add no dependencies. Do NOT commit. Do NOT edit this spec.

## Out of scope

- Soft-warn / "you're at 80%" nudge (deferred).
- Per-team cap, queue/throttle-near-cap, SDK in-sandbox `maxTurns`/budget tripwire.
- Mode-aware per-task exemption for conversational threads (uniform per-task is the call).
- Retention/pruning of old audit rows.

## When done — report precisely (REAL output)

- File-by-file summary (one line each).
- The tail of `npm run gate` (real, with test counts) + baseline-vs-after test count.
- Confirm by reasoning: admission reject, mid-task pre-dispatch stop, `0`-disable, and
  unknown-user paths each behave per the criteria.
- Any deviation and why.
