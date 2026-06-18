# Task: M4 S03 — persisted SessionStore (kills restart amnesia)

You are implementing one slice in `/Users/jedanner/workspace/sa-wt-sonnet-m4-s03-session-store`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m4-s03-session-store`. Work only in this worktree.

## Context — read before writing code

- Design intent: `design/0002` §2 (the persisted session index) — the durable spine.
  Today truth lives only in an in-memory `Map`; a gateway restart loses it, so old
  threads go dead until re-@mentioned ("restart amnesia"). This slice adds a
  persisted store so a thread reply after a restart **rehydrates** instead of being
  ignored. Storage engine: **better-sqlite3** (decided).
- Builds on M4 S01/S02 (merged): `sessionKey = team:channel:threadTs`; `QueueItem`
  has `teamId`/`userId`/`profileId`; `getProfile`/`DEFAULT_PROFILE_ID` exist.

## Key facts (grounded — don't re-derive; line numbers are current)

- **SessionManager** (`src/sessions/manager.ts`): constructor takes
  `{ idleTimeoutMs, factory, slack }` (`:30-38`) — the store is injected here as a
  4th dep. `getOrCreate(key, profileId?)` creates the runner at `:59` (write the row
  here). `enqueueExisting(key, item)` returns `false` at `:87` when no in-memory
  session — **this is the rehydrate hook**. `drain()` processes turns (`:125-197`).
  `reapSession(key)` deletes + disposes at `:116/:122` — set status `reaped` here.
- **Thread-reply ignore path** (`src/slack/listener.ts:116,125-126`): on
  `enqueueExisting → false` it logs "ignored — no session" and drops the message.
  Rehydrate changes exactly this: only truly-unknown threads (no store row) get
  dropped.
- **No protocol change needed.** The SDK resume pointer is persisted *inside the
  volume* by the runner (`runner/src/main.ts`, `/workspace/.slackbot/session-id`)
  and is never sent to the gateway. To rehydrate, the gateway only needs to
  recreate the runner — which resumes from the volume automatically. Do **not**
  touch `protocol.ts` or the runner.
- **Volume name is a pure function of the key** (`src/runner/docker.ts:50-53,404-407`:
  `slackbot-ws-${sanitizeKey(key)}`) — recomputable, so the store need not be told it
  by the runner.
- **better-sqlite3 is not yet a dependency** — add it (+ `@types/better-sqlite3` as a
  devDep). It will be the first native dep; CI (`npm ci` on ubuntu) builds it fine.
- **Tests** inject fakes via constructor (`test/manager.test.ts` `makeManager` `:8-12`;
  `test/listener.test.ts` `makeDeps` `:9-18`). All SessionManager-constructing tests
  must pass the new store.

## CRITICAL — do not stop after exploration

Implement end to end: edit source + tests, run `npm run gate`, fix, repeat until
green. Yielding after only exploring is a failure.

## What to build

1. **`SessionStore` interface + a SQLite implementation** in `src/sessions/store.ts`:
   - Interface methods (name as you see fit, but cover): `recordSession(row)` (insert
     or upsert on session create), `touch(key, atMs)` (bump `last_active_at`),
     `setStatus(key, status)` (e.g. on reap), `get(key)` (→ row or undefined, for
     rehydrate), and `close()`.
   - `SqliteSessionStore` backed by better-sqlite3, opening a DB at a configurable
     path. Create the schema on construction (idempotent — `CREATE TABLE IF NOT
     EXISTS`). Use the **`design/0002` §2 schema** as the source of truth:
     `sessions(session_key PK, team_id, user_id, channel_id, thread_ts, profile_id,
     harness_version, sdk_session_id, volume_name, created_at, last_active_at,
     status)` plus indexes on `team_id` and `last_active_at`. Make columns the
     gateway doesn't yet know (`sdk_session_id`, `harness_version`, `volume_name`)
     **nullable and leave them unset** this slice — they're populated by later work
     (some need the protocol change). Also create the **`audit_events`** table from
     `0002` §2 (schema only — no writes; the audit *layer* is M6).
   - Timestamps via `Date.now()`.
2. **Inject the store into `SessionManager`** (4th constructor dep) and wire it:
   - On session create in `getOrCreate`: `recordSession(...)` with the metadata the
     gateway has (`session_key`, `team_id`, `user_id`, `channel_id`, `thread_ts`,
     `profile_id`, `created_at`, `last_active_at`, `status='active'`). channel/thread
     come from the `QueueItem`/key — thread them through if `getOrCreate` needs them.
   - On each turn in `drain`: `touch(key, Date.now())`.
   - In `reapSession`: `setStatus(key, 'reaped')`.
3. **Rehydrate-on-reply** — the payoff:
   - When a thread reply has **no in-memory session** but the store has a row for the
     key, recreate the session (via the existing create path, using the stored
     `profile_id`) and enqueue the message — instead of dropping it. When the store
     has **no** row either, keep today's behavior (ignore). Put this logic in the
     manager (keep the listener thin); it's fine to make the thread-reply enqueue
     path async.
4. **Config + wiring**: add a `SESSION_DB_PATH` setting (`src/config.ts` + `.env.example`),
   default `.data/sessions.db`; ensure the parent dir is created. Construct the
   `SqliteSessionStore` in `src/index.ts` and inject it into `SessionManager`. Add
   `.data/` to `.gitignore`.

## Acceptance criteria

1. `npm run gate` passes (existing tests updated for the new constructor dep; new
   tests added; `boundaries` clean).
2. `SessionStore` interface + `SqliteSessionStore` exist; schema matches `0002` §2
   (`sessions` + `audit_events` + the two indexes); created idempotently.
3. **Restart amnesia is gone:** a thread reply for a key that has a store row but no
   in-memory session recreates the session (the factory's `create` is called again)
   and the message is processed — proven by a test using `FakeRunnerFactory` + an
   in-memory store: create a session, simulate its in-memory eviction (reap), send a
   thread reply, assert the runner was re-created and the message drained.
4. A truly-unknown thread (no store row, no memory) is still ignored.
5. Store unit tests use a **real** `SqliteSessionStore` on `':memory:'`: record→get
   round-trip, `touch` updates `last_active_at`, `setStatus` updates status.
6. No behavior change for the normal (in-memory hit) path.

## Hard constraints (do NOT violate)

- Gate must pass; paste the tail of `npm run gate` when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers).
- **Touch no `protocol.ts` (either copy) and nothing in `runner/`.** This slice is
  gateway-side only; the resume pointer stays in the volume.
- `boundaries` must stay clean: `src/sessions/store.ts` may import `better-sqlite3`
  (npm) but must not import `@slack/bolt`, the Agent SDK, or the `runner/` package.
  (Don't import `sanitizeKey` from `runner/docker.ts` — leave `volume_name` unset.)
- Never log message contents or tokens. Logging a session key on rehydrate is fine.
- Tests stay offline — `':memory:'` SQLite only; no file/network in unit tests.
- Do NOT commit — leave the working tree for coordinator review. Do not modify
  `planning/m4-s03-spec.md` (already committed).

## Out of scope (do NOT build)

- Populating `sdk_session_id` / `volume_name` / `harness_version` (need the protocol
  change or later wiring) — leave nullable/unset.
- The audit *layer* / writing `audit_events` rows — M6 (create the table only).
- Volume GC by `last_active_at` TTL — later.
- Any enforcement (spend, authz) — M6.

## When done — report precisely (with REAL command output)

- Files changed, one line each (+ the added dependency).
- The actual tail of `npm run gate` (real, with test count).
- A one-line confirmation that the rehydrate test proves a post-eviction thread
  reply recreates the session.
- Anything a unit test can't catch, or any deviation from this spec and why.
