# Task: M4 S02 — introduce the profile seam (one profile, no behavior change)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md` first**
(gate, invariants, conventions), then the context below. You are on branch
`sonnet/m4-s02-profile-seam`.

## Context — read before writing code

- Design intent: `design/0003` (modes & profiles) — "introduce the profile bundle +
  registry and thread `profileId` through the entry point and `RunnerFactory.create`,
  with exactly one profile, so it's a no-op refactor that creates the seam." This
  slice builds ONLY that seam. Profile *facets* that must reach the container
  (system prompt, tool policy) are OUT of scope — they need protocol changes (later).
- Builds on M4 S01 (already merged): `QueueItem` now carries `teamId?`/`userId?`.

## Key facts (grounded — don't re-derive)

- **`RunnerFactory` is the only signature to extend** (`src/runner/types.ts:13-15`):
  `create(sessionKey: string): Promise<SessionRunner>`. Two implementations:
  `DockerRunnerFactory.create` (`src/runner/docker.ts:402`) and `FakeRunnerFactory.create`
  (`src/runner/fake.ts:65`).
- **The factory is called once per session** at `src/sessions/manager.ts:55`
  (`const runner = await this.factory.create(key);`), inside `getOrCreate()`.
- **`QueueItem`** is at `src/sessions/manager.ts:5-11`; constructed at
  `src/slack/listener.ts:74-80` (mention) and `:114-120` (thread reply).
- **No profile notion exists today** anywhere in `src/` (grep-confirmed). The
  runner's system prompt is hardcoded container-side, behind the protocol — NOT
  reachable from the gateway without a protocol change. So this slice touches no
  prompt/tool facets.
- **`DockerRunnerFactory` reads resource caps/image from its injected config**
  (`src/runner/docker.ts:407-419`), not per-call — leave that as-is.

## CRITICAL — do not stop after exploration

Implement end to end: edit source + tests, run `npm run gate`, fix, repeat until
green. Yielding after only exploring is a failure.

## What to build

1. **A profiles module** — e.g. `src/profiles/registry.ts` exporting:
   - `interface Profile { id: string; label: string }` — minimal on purpose;
     facets are future slices. Do NOT add prompt/tool/network fields yet.
   - a static `PROFILES` registry with exactly one entry, `conversational`.
   - `DEFAULT_PROFILE_ID = 'conversational'` and a `getProfile(id: string): Profile`
     resolver (throws or falls back to default on unknown — your call, but be
     explicit and test it).
2. **`QueueItem` gains `profileId?: string`** (`manager.ts`). The **entry point
   selects the profile** (per `design/0003`): set `profileId: DEFAULT_PROFILE_ID`
   on both `QueueItem` construction sites in `listener.ts`.
3. **Thread the resolved profile to the factory.** Extend `RunnerFactory.create`
   to `create(sessionKey: string, profile: Profile): Promise<SessionRunner>`.
   In `SessionManager.getOrCreate`, resolve the queue item's `profileId`
   (default when absent) via `getProfile(...)` and pass the `Profile` to
   `factory.create(key, profile)`. **Both** factories take the new param;
   `DockerRunnerFactory` may ignore it for now (thread-through only — no docker-arg
   change); `FakeRunnerFactory` should record it so a test can assert it.

## Acceptance criteria

1. `npm run gate` passes (existing tests updated, new ones added; `boundaries` clean).
2. The `Profile` type + one-entry `conversational` registry + `getProfile` exist and
   are unit-tested (resolve known id; behavior on unknown id).
3. `RunnerFactory.create` takes `(sessionKey, profile)`; both implementations and
   the `manager.ts:55` call site updated; the resolved profile flows
   listener → manager → factory.
4. **No behavior change:** with one profile defaulted everywhere, the bot behaves
   exactly as before. Nothing selects a non-default profile; `DockerRunnerFactory`
   produces the same `docker run` argv as today (the docker arg test must still pass
   unchanged except for the added `create` parameter).
5. Tests updated for the signature change (`test/docker.test.ts:490-491` factory
   `create` call; `test/manager.test.ts` factory-override sites ~`:39-44`,`:84-89`);
   add a test asserting the `conversational` profile is the one passed to
   `factory.create`.

## Hard constraints (do NOT violate)

- The gate must pass; paste the tail of `npm run gate` when done.
- No `any`, no `@ts-ignore`; `NodeNext` ESM (`.js` import specifiers).
- **Touch no `protocol.ts`** (either copy) and add **no** fields that would need to
  cross the protocol. This seam is gateway-side only.
- Respect the boundary rules (`npm run boundaries`): the new `src/profiles/` module
  must not import `@slack/bolt`, the Agent SDK, or the `runner/` package.
- Never log message contents or tokens.
- Add no dependencies.
- Do NOT commit — leave the working tree for coordinator review.

## Out of scope (do NOT build)

- Any profile *facet* (system prompt, tool policy, network/resource, isolation tier)
  or anything that changes the container — later slices, some need protocol changes.
- A second profile, profile selection UX, per-channel binding — future.
- The persisted session store / `profile_id` column — that is **M4 S03**.

## When done — report precisely (with REAL command output)

- Files changed, one line each.
- The actual tail of `npm run gate` (real, with test count).
- Confirmation of no behavior change (one profile, defaulted; docker argv unchanged).
- Anything a unit test can't catch, or any deviation from this spec and why.
