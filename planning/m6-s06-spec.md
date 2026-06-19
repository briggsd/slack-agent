# Task: M6 S06 — volume GC (reap idle Docker volumes via a last_active_at TTL) — roadmap M6

You are implementing one well-scoped slice in **slack-agent** (TypeScript, ESM, NodeNext,
Node 20+; strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; **no `any`, no
`@ts-ignore`**). Read root `CLAUDE.md` first for conventions and the gate.

Today every session gets a named Docker volume (`slackbot-ws-<key>`), and **nothing ever
removes them** — `docs/ARCHITECTURE.md` literally says "prune manually". This slice adds a
periodic in-process sweep that removes the volume for sessions idle past a TTL and deletes
their session row, so a returning user starts fresh instead of rehydrating onto a missing
volume.

## CRITICAL — do not stop after exploration

Do NOT pause or yield until the task is fully implemented AND `npm run gate` passes. Make
every edit, add tests, run the gate, fix failures, then stop. Yielding after only exploring
(zero file changes) is a failure.

## Decided design (do not re-litigate)

- **Policy:** a volume is GC-eligible when its session's `last_active_at` is older than
  **`VOLUME_TTL_MS` (default 7 days)**. The container already reaps at the 10-min idle
  timeout; the volume outlives it so a user can return within the week. On GC, **delete the
  session row** (audit_events are keyed separately and untouched).
- **Where it runs:** an **in-process periodic sweep** inside `SessionManager` (mirrors the
  existing idle-reaper timer), NOT a separate worker. Interval = `VOLUME_GC_INTERVAL_MS`
  (default 1 hour).
- **Seam:** a new single-purpose **`VolumeReaper`** interface — do NOT add a method to
  `RunnerFactory` (that breaks the many inline `{ create }` factory literals in tests).
- **Name derivation stays in the docker layer.** The reaper takes a **sessionKey** and
  derives the volume name itself (`volumeNameFor`), so the manager never imports docker
  internals and the reserved `volume_name` column stays unused (leave it null — out of scope).

## Acceptance criteria

1. **`VolumeReaper` seam** — in `src/runner/types.ts`, add:
   ```ts
   /** Removes the Docker volume backing a session. Implemented by the docker factory;
    *  injected into SessionManager for the volume-GC sweep. */
   export interface VolumeReaper {
     /** Remove the volume for `sessionKey`. Resolves true when the volume is gone
      *  (removed, or already absent); false on a real failure (e.g. still in use). */
     removeVolumeForSession(sessionKey: string): Promise<boolean>;
   }
   ```

2. **`DockerRunnerFactory implements VolumeReaper`** (`src/runner/docker.ts`) — add
   `removeVolumeForSession(key)`: compute `volumeNameFor(key)`, spawn `docker volume rm
   <name>` via the existing `this.spawnFn` (mirror the kill-escalation spawn at ~L377,
   `stdio: 'ignore'`-style but capture exit). Resolve `true` on exit code 0 **or** when
   stderr indicates the volume does not exist ("No such volume"); `false` otherwise. Do not
   throw. Keep it metadata-only in logs (volume name + outcome, never content).

3. **Store methods** (`src/sessions/store.ts`) — add to the `SessionStore` interface +
   `SqliteSessionStore` (hoisted prepared statements, like `stmtRecord`/`stmtGet`) +
   `NoopSessionStore` (no-ops returning `[]`/void):
   ```ts
   /** Rows whose last_active_at is strictly older than `cutoffMs` (uses the
    *  sessions_last_active_at index). For the volume-GC sweep. */
   listExpired(cutoffMs: number): SessionRow[];
   /** Delete a session row by key (volume-GC removes the row once its volume is gone). */
   deleteSession(key: string): void;
   ```
   Query: `SELECT * FROM sessions WHERE last_active_at < ?` (ORDER BY last_active_at).
   `DELETE FROM sessions WHERE session_key = ?`.

4. **GC sweep in `SessionManager`** (`src/sessions/manager.ts`):
   - Constructor `opts` gains three **optional** fields: `volumeReaper?: VolumeReaper`,
     `volumeTtlMs?: number` (default `7 * 24 * 60 * 60 * 1000`), `gcIntervalMs?: number`
     (default `60 * 60 * 1000`). Store them on `private readonly` fields.
   - **Only when `volumeReaper` is provided**, start an unref'd `setInterval(gcIntervalMs)`
     that runs the sweep (copy the `unref` guard used in `resetIdleTimer` ~L271). When it is
     absent (e.g. the fake backend, and every existing test), GC is OFF and behaviour is
     unchanged — the existing 326 tests must still pass untouched.
   - The sweep (`private async runVolumeGc()`):
     - Guard against overlap with a `private gcRunning = false` flag (skip if already running).
     - `const cutoff = Date.now() - this.volumeTtlMs; const rows = this.store.listExpired(cutoff);`
     - For each row: **skip if `this.sessions.has(row.session_key)`** (a live in-memory
       session still holds its container/volume — never rm a volume in use).
     - `const ok = await this.volumeReaper.removeVolumeForSession(row.session_key);`
       if `ok` → `this.store.deleteSession(row.session_key)` and
       `console.log('[session] gc removed volume + row: <key>')`. If not ok → log and leave
       the row for the next sweep (best-effort; one row's failure must not abort the loop —
       wrap each row in try/catch).
   - Add a `stopVolumeGc()` (clear the interval) and call it from `disposeAll()` so a clean
     shutdown / test teardown does not leak the timer.

5. **Config** (`src/config.ts`) — add `VOLUME_TTL_MS` and `VOLUME_GC_INTERVAL_MS` to the
   config type and parse with `optionalEnvNumber('VOLUME_TTL_MS', 7*24*60*60*1000)` /
   `optionalEnvNumber('VOLUME_GC_INTERVAL_MS', 60*60*1000)`, mirroring `IDLE_TIMEOUT_MS`
   (declared ~L112, parsed ~L133).

6. **Wire it** — `src/app.ts` `GatewayDeps` + `buildGateway` thread `volumeReaper?`,
   `volumeTtlMs?`, `gcIntervalMs?` into the `new SessionManager({...})`. `src/index.ts`:
   in the **docker** branch only, keep a reference to the `DockerRunnerFactory` instance and
   pass it as `volumeReaper` (plus `config.VOLUME_TTL_MS` / `config.VOLUME_GC_INTERVAL_MS`);
   the **fake** branch passes no `volumeReaper` (no real volumes → GC stays off). Note
   `baseFactory` is typed `RunnerFactory`; hold the concrete docker factory in a separate
   `let volumeReaper: VolumeReaper | undefined` so the type is right.

7. `npm run gate` green; tests below added; existing 326 tests unchanged.

## Where to look (precedents to mirror)

- **Timer + `unref`** — `manager.ts` `resetIdleTimer` (~L263) shows the `setTimeout` +
  `if ('unref' in timer) timer.unref()` pattern; use the same shape for the GC `setInterval`.
  `disposeAll` (~bottom of the class) is where to call `stopVolumeGc()`.
- **Store method shape** — `recordSession`/`setStatus`/`get` in `SqliteSessionStore`
  (prepared statements hoisted in the constructor ~L126); `NoopSessionStore` no-ops (~L282).
  The `sessions_last_active_at` index already exists (~L200) — your query uses it.
- **Volume naming + docker spawn** — `src/runner/docker.ts`: `volumeNameFor(key)` (L56),
  `DockerRunnerFactory` (L398), its `spawnFn` field + the kill-escalation spawn (~L377) for
  how to run a one-off `docker …` and read its exit. Volume mount that creates the volume:
  `-v ${volumeName}:/workspace` (L416).
- **Manager construction wiring** — `src/app.ts:27` `buildGateway` → `new SessionManager`;
  `src/index.ts:91` the `RUNNER_BACKEND === 'docker'` vs fake branch; `:134` where
  `idleTimeoutMs`/`gateTimeoutMs` are already passed through.

## Test infrastructure (do not skip)

- **Store** — `test/store.test.ts` uses `new SqliteSessionStore(':memory:')`. Add tests:
  `listExpired` returns only rows strictly older than the cutoff (insert rows with crafted
  `last_active_at`, assert the boundary); `deleteSession` removes a row (`get` → undefined
  after). Use explicit `last_active_at` values — do NOT rely on wall-clock.
- **Manager sweep** — `test/manager.test.ts` already has `FakeSlackClient`, `CapturingStore`
  (extend it: it must implement the new `listExpired`/`deleteSession` — back them with its
  internal `rows` map), and `FakeRunnerFactory`. Add a **`FakeVolumeReaper`** that records
  the keys it was asked to remove and returns a configurable boolean. Tests:
  - sweep removes an expired row's volume and deletes the row (seed a row via
    `store.recordSession` with an old `last_active_at`; construct the manager with the fake
    reaper + `gcIntervalMs: 20`, `volumeTtlMs: 1000`; wait ~40ms; assert the reaper saw the
    key and `store.get` is undefined);
  - a **live** in-memory session is skipped (enqueue so it is in the `sessions` map with an
    old row; assert the reaper was NOT called for it);
  - reaper returning **false** leaves the row (no delete, retried next sweep);
  - GC is **off when no `volumeReaper`** is passed (no interval, no calls) — assert a manager
    built without a reaper never touches the store's delete path.
  - Always `await manager.disposeAll()` at the end so the interval is cleared (no leaked
    timers in the suite).
- **Docker reaper** — `test/docker.test.ts` uses the `spawn` fake (`FakeChildProcess`).
  Add a test that `removeVolumeForSession('T:C:TH')` spawns `docker` with
  `['volume', 'rm', 'slackbot-ws-t-c-th']` (assert the exact args via the spawn fake) and
  resolves true on exit 0 / true on a "No such volume" stderr / false on other failure.

## Hard constraints

- `npm run gate` must pass (tsc + runner type-check + vitest + dependency-cruiser). Run it
  yourself, paste the tail. Offline — no Docker/Slack/network in tests (use the fakes).
- **No `any`, no `@ts-ignore`.** Optional constructor fields under
  `exactOptionalPropertyTypes` — pass them with the conditional-spread idiom if needed.
- **Never rm a volume for a live session** — the `this.sessions.has(key)` skip is load-bearing.
- Best-effort: a reaper failure or a single bad row must not throw out of the sweep, and the
  GC timer must be `unref`'d so it never holds the process open.
- Do NOT modify `RunnerFactory` (keep inline test factories working). Do NOT touch
  `protocol.ts` (either copy). `@slack/bolt` stays only in `src/index.ts`.
- Never log message content — volume names, keys, counts, outcomes only.
- Keep the diff focused: `runner/types.ts`, `runner/docker.ts`, `sessions/store.ts`,
  `sessions/manager.ts`, `config.ts`, `app.ts`, `index.ts`, and the three test files.

## Out of scope (do NOT build)

- Populating the `volume_name` column (GC derives the name from the key — leave it null).
- A separate GC worker/cron process; tombstone status (we delete the row).
- Spend caps, invocation authz, egress-lock, durable park, cost/token audit — other slices.

## When done — report precisely (REAL output)

Paste the actual `git status --short`, `git diff --stat`, and the full `npm run gate` tail
(with vitest pass/fail counts). Do not claim any change you cannot point to in `git diff`.
Then: (1) files changed + why; (2) how the sweep avoids removing a live session's volume and
how a failed rm is retried; (3) confirm the test files appear in the diff and the count rose
from 326; (4) anything unsatisfied and why. Do NOT edit this spec file.
