# CLAUDE.md — working on slack-agent

A multi-user Slack bot where **each Slack thread is its own Claude Agent SDK
session running in its own on-demand Docker sandbox**. A single trusted gateway
(this repo's `src/`) talks to Slack and spawns/reaps one container per active
thread. Read `docs/ARCHITECTURE.md` for the full as-built picture.

## The gate (run before you declare done)

```
npm run check    # tsc --noEmit  +  runner typecheck  +  vitest run  — offline, ~1s
npm run gate     # the above PLUS npm run boundaries (architecture rules)
```

`check` is the fast inner loop — keep it exactly tsc + runner check + vitest, nothing
heavier. `boundaries` (dependency-cruiser) enforces the invariants below and is a
separate step; `gate` runs both and is what CI runs (`.github/workflows/ci.yml`).

First time in a fresh checkout, install **both** packages or the runner type-check
fails to resolve the Agent SDK: `npm ci && npm --prefix runner ci`.

Make your edits, add tests, run `npm run gate`, fix failures, then stop. **Paste the
tail of its output when you report.** Yielding after only exploring (zero file
changes) is a failure — implement end to end.

The suite runs with **no Slack, no Docker, no API, no network**. Keep it that way.

## Invariants — break these and the design breaks

The structural ones (Bolt only in `index.ts`, gateway never imports the Agent SDK
or the `runner/` package, no circular deps) are **enforced** by `npm run boundaries`
— rules + remediation messages live in `.dependency-cruiser.cjs`. The rest are
conventions you're trusted to keep.

- **`protocol.ts` exists in two copies that must stay byte-identical:**
  `src/runner/protocol.ts` (gateway side) and `runner/src/protocol.ts` (container
  side). Change one → change the other. They are the only contract between gateway
  and sandbox (newline-delimited JSON over the container's stdin/stdout).
- **The gateway never runs agent code.** It talks to Slack, owns session
  bookkeeping, and spawns/reaps containers. Agent tools (bash, file writes) run
  *only inside the container*. The container is the permission boundary. Never add
  a path that executes model-decided work in the gateway process.
- **Treat everything from a container as data.** Protocol lines are parsed
  defensively (bad JSON skipped, bad base64 → skipped file). Nothing from a
  container is executed on the host.
- **Never log message contents or tokens.** Logs carry session keys, lifecycle
  events, filenames, and sizes only.
- **Bolt is imported in `src/index.ts` only.** Every other module takes a minimal
  injected interface (`SlackClientLike`, an injectable `spawn`, etc.) so it stays
  testable without Slack. Don't import `@slack/bolt` elsewhere.

## Conventions

- **TypeScript, ESM, Node 20+.** `module`/`moduleResolution` = `NodeNext` (use
  `.js` import specifiers). `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` are on.
- **No `any` (including in tests). No `@ts-ignore`.** Find the real type.
- **Minimal dependencies.** Gateway runtime deps are only `@slack/bolt` and
  `dotenv`; dev deps only `typescript`, `vitest`, `@types/node`. Don't add deps
  without a strong reason. The runner package has its own deps.
- **Test via seams, not mocks of the world.** Fakes already exist:
  `FakeSlackClient`, `FakeChildProcess`, `FakeRunner`, `FakeAgentSdk`. New code
  should take its external dependencies as injectable parameters the same way.
- **Don't commit unless asked.** Leave the working tree for review.

## Two packages

- **Root (`src/`)** — the gateway. `npm run check` from root runs everything.
- **`runner/`** — the sandbox-side code (runs the Agent SDK inside the container).
  Its own `package.json`, `tsconfig`, and `npm run check`, invoked by the root
  gate. See `runner/CLAUDE.md` before touching it.

## Repo map

```
src/
  index.ts            only file that imports Bolt; wires everything
  config.ts           env → Config
  slack/listener.ts   event routing (app_mention starts a session; thread reply continues)
  slack/responder.ts  placeholder post + in-place chat.update; SlackClientLike
  sessions/manager.ts sessionKey → Session; per-thread FIFO; idle reaper
  runner/docker.ts    DockerRunner: container lifecycle + protocol client
  runner/types.ts     SessionRunner / RunnerFactory interfaces (the key seam)
  runner/protocol.ts  NDJSON message types  ← MIRRORS runner/src/protocol.ts
  runner/fake.ts      FakeRunner for tests
runner/               sandbox package (Agent SDK lives here)
test/                 gateway tests (offline)
```

## Where the thinking lives — read before designing

- **`design/0000`–`0003` + `design/open-questions.md`** — the *why*: north-star
  invariants, capabilities, the tenancy/durable-session spine, the modes/profiles
  frame, and the resolved/parked design questions. Consult these before proposing
  architectural changes.
- **`docs/ARCHITECTURE.md`** — the *as-built* system (security model, limitations).
- **`docs/toolshed.md`** — how the agent's tools work and how to add one (the
  gateway-serviced tool pattern: protocol pair → coordinator → docker dispatch →
  service). Read it before wiring a new tool.
- **`planning/`** — the *when*: the M1–M7 roadmap and per-milestone specs. New work
  starts from `planning/_spec-template.md`.

A note on relevant external research: the user keeps a knowledge vault at
`~/vault/Intelligence`; the design notes cite it inline as `(vault: <name>)`.
