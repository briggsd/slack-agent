# Task: M2 — Docker session runner (Agent SDK in a container, NDJSON stdio protocol)

You are implementing milestone 2 in `/home/jedanner/workspace/slackbot` (TypeScript, Node 20+,
ESM, vitest, strict tsc). Read `planning/ARCHITECTURE.md` and skim M1's code first — M1 shipped
the gateway (Slack listener, `SessionManager`, `SessionRunner`/`RunnerFactory` interfaces in
`src/runner/types.ts`, `FakeRunner`). M2 replaces the fake with a real sandbox: **one Docker
container per session, running the Claude Agent SDK, speaking NDJSON over stdio**. You are on
branch `feat/m2-docker-runner`.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the test gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding after
only exploring (with zero file changes) is a failure — implement end-to-end in this run.

## CRITICAL — Agent SDK usage must be grounded, not recalled

Install `@anthropic-ai/claude-agent-sdk` (latest) in `runner/` and **read its type
definitions in `node_modules/@anthropic-ai/claude-agent-sdk/` before writing any code that
calls it**. Use only symbols you can point to in those `.d.ts` files (expected shape:
a `query({ prompt, options })` async-generator API with a `resume`/session-id mechanism and
message types like system-init / assistant / result — but the `.d.ts` is the source of truth,
not this sentence). If the real API differs, follow the real API and note the difference in
your report.

## Acceptance criteria

1. `npm run check` passes (gateway tests including all M1 tests, plus new M2 tests). The
   runner package has its own `npm run check` (tsc) wired into the root check via
   `npm --prefix runner ...` or a root script.
2. **NDJSON protocol** (versioned in one shared place, `src/runner/protocol.ts`, re-used by
   the runner via a copied or imported definition — document your choice):
   - gateway → runner: `{"type":"user_message","id":"<uuid>","text":"..."}`
   - runner → gateway: `{"type":"ready"}` once the runner is accepting input;
     `{"type":"status","id":...,"text":"..."}` (e.g. tool-use notes);
     `{"type":"text","id":...,"text":"..."}` exactly once per user_message (the final
     assistant text); `{"type":"error","id":...,"message":"..."}` on per-message failure.
   One JSON object per line on stdout; runner logs go to **stderr only**.
3. **Runner container** (`runner/` directory):
   - `runner/src/main.ts`: reads NDJSON from stdin line-by-line, for each `user_message`
     calls the Agent SDK with the message text, emits `status` events for tool use, emits the
     final `text`. Maintains the SDK session across messages: capture the SDK session id from
     the first turn, persist it to `/workspace/.slackbot/session-id`, and `resume` it on
     process start so an idle-reaped container picks up where it left off.
   - Working directory for the agent: `/workspace` (the volume mount). Set `HOME=/workspace`
     (or the SDK's state-dir option if one exists in the `.d.ts`) so agent state lands on the
     volume too.
   - `runner/Dockerfile`: `node:22-slim` (or `-bookworm-slim`), non-root user, deps installed
     with `npm ci`, runner compiled with tsc at build time, `ENTRYPOINT ["node","dist/main.js"]`.
     Include `git`, `curl`, `ripgrep` in the image (useful agent tools), nothing exotic.
   - `runner/package.json` + `runner/tsconfig.json` (same strict settings as root).
4. **DockerRunner** (`src/runner/docker.ts`) implementing `SessionRunner` + a
   `DockerRunnerFactory` implementing `RunnerFactory`:
   - `create(sessionKey)` spawns `docker run --rm -i` with: a sanitized container name
     (`slackbot-<sanitized-key>`), a named volume `slackbot-ws-<sanitized-key>` mounted at
     `/workspace` (this is what makes resume-after-reap work), `-e ANTHROPIC_API_KEY`,
     resource limits from config (`--memory`, `--cpus`, `--pids-limit`,
     `--security-opt no-new-privileges`), and the configured image.
   - Waits for the `ready` event (with a configurable timeout) before resolving `create`.
   - `send(message)` writes one `user_message` line and yields mapped `RunnerEvent`s
     (`status`→status, `text`→text then return, `error`→error then return). A configurable
     per-turn timeout yields an `error` event and leaves the runner usable.
   - `dispose()` ends stdin / SIGTERMs the child and force-kills (`docker kill` or SIGKILL)
     after a grace period. Never leaks the child process.
   - If the container process exits unexpectedly, in-flight `send` yields an `error` event.
5. **Testability seam — no Docker needed in unit tests**: `DockerRunner` must take an
   injectable `spawn`-like function (default: `child_process.spawn` invoking the `docker`
   CLI). Tests inject a fake child (PassThrough stdin/stdout/stderr + emitter) and assert:
   correct docker argv construction (image, volume name, limits, env passthrough without
   leaking the key into argv — use `-e ANTHROPIC_API_KEY` inheritance form, not `-e K=V`),
   ready-handshake, message/event round-trip incl. interleaved status events, per-turn
   timeout, unexpected-exit error, dispose kill-escalation (use fake timers), and that
   partial stdout lines are buffered until newline (NDJSON framing with chunk splits
   mid-line — this is the classic bug; test it explicitly).
6. **Wiring**: `src/index.ts` selects the factory via config `RUNNER_BACKEND=fake|docker`
   (default `fake` so M1 behavior is unchanged); docker config (image name, limits, timeouts)
   in `src/config.ts` with sane defaults; `.env.example` updated (ANTHROPIC_API_KEY,
   RUNNER_BACKEND, RUNNER_IMAGE, etc.).
7. **Runner main.ts logic unit-tested** (vitest in root `test/` or `runner/test/` — your
   choice, but it must run in the root gate): factor the stdin-loop + SDK interaction so the
   SDK client is injectable; test with a fake SDK generator: session-id persisted, resume
   passed on restart, status/text/error emission, malformed input line → error event, not a
   crash.
8. **Docs**: README gains a "Sandbox runner" section — how to build the image
   (`docker build -t slackbot-runner runner/`), required env, the resume-after-reap story,
   and a smoke-test script `scripts/smoke-docker.sh` (build image, echo one message through
   a real container, requires ANTHROPIC_API_KEY; NOT part of the gate).

## Where to look

- M1 contracts: `src/runner/types.ts` (do not change the `SessionRunner`/`RunnerFactory`
  interfaces), `src/runner/fake.ts` (the factory/runner shape to mirror),
  `src/sessions/manager.ts` (how send() events are consumed), `test/manager.test.ts`
  (fake-timer + blocking-turn test idioms to reuse).
- Agent SDK ground truth: `runner/node_modules/@anthropic-ai/claude-agent-sdk/**/*.d.ts`.

## Test infrastructure (do not skip)

- Reuse the M1 idioms: capture fakes + manually-resolved promises + `vi.useFakeTimers()`.
- New fakes to build: `FakeChildProcess` (PassThrough-based stdio + 'exit' emitter) for
  DockerRunner tests; `FakeAgentSdk` (scripted async generator) + in-memory fs seam (inject
  read/write fns for the session-id file) for runner main tests.
- Aim ≥ 18 new tests across ≥ 2 new test files. All offline; `docker` must NOT be invoked
  by the gate.

## Hard constraints (do NOT violate)

- **The test gate must pass** (`npm run check`). Run it yourself before finishing and paste
  the tail of its output.
- Same strict tsconfig as M1; no `any`, no `@ts-ignore`.
- Gateway runtime deps unchanged (`@slack/bolt`, `dotenv`) — docker is driven via the CLI
  through `child_process`, no dockerode. Runner deps: `@anthropic-ai/claude-agent-sdk` only.
- Do not modify M1 behavior or its tests except where wiring requires (config/index).
- Never log message contents or the API key; the key must not appear in docker argv.
- Do NOT commit — leave the working tree for coordinator review.

## Out of scope (do NOT build)

- Streaming partial text into Slack, rate limits, per-user budgets (M3).
- Container pooling/pre-warm, multi-host scheduling, image auto-build from the gateway.
- Volume garbage collection (note it in README as a known operational task).

## When done — report precisely (with REAL command output)

RUN and paste the ACTUAL output of: `git status --short`, `git diff --stat`,
`git ls-files --others --exclude-standard`, and the full test-gate tail with pass/fail
counts. Do not describe any change you cannot point to in those listings. Then: (1) files
created/changed and why; (2) the exact Agent SDK symbols you used and where they appear in
the `.d.ts` (file + name); (3) how tests cover criteria 4, 5, 7; (4) anything not satisfied.
