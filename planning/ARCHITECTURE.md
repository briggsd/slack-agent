# Slackbot ↔ Remote Claude — Architecture

A multi-user Slack bot where **each Slack thread is its own Claude session**, running in an
**on-demand sandboxed environment**, with many threads active concurrently.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Claude integration | Claude Agent SDK (agentic Claude Code engine per session) |
| Sandbox | One local Docker container per active session, spawned on demand, idle-reaped |
| Stack | TypeScript / Node 20+, ESM |
| Slack connectivity | Socket Mode (Bolt for JS) — no public URL needed |

## Components

```
Slack workspace
   │  (websocket, Socket Mode)
   ▼
Gateway (this repo, src/) — single Node process
   ├─ slack/listener.ts   app_mention starts a session; thread replies continue it
   ├─ slack/responder.ts  placeholder message + throttled chat.update streaming
   ├─ sessions/manager.ts sessionKey → Session; per-session FIFO; idle reaper
   └─ runner/             SessionRunner abstraction
        ├─ M1: FakeRunner (echo)            ← this milestone
        └─ M2: DockerRunner — `docker run -i` per session, NDJSON over stdio,
               container runs the Agent SDK; session state on a named volume
               so an idle-reaped session can resume.
```

- **Session key**: `${channel}:${thread_ts ?? ts}` — one session per Slack thread.
- **Concurrency model**: messages within a thread are processed serially (FIFO);
  different threads run fully concurrently.
- **Idle reaping**: a session's runner is disposed after `IDLE_TIMEOUT_MS` of inactivity;
  the session can be recreated transparently on the next message (M2: Agent SDK `resume`).

## Milestones

1. **M1 — Gateway skeleton**: Bolt Socket Mode wiring, session manager, runner
   abstraction with a fake runner, full unit-test coverage. No Docker, no Agent SDK.
2. **M2 — Docker session runner**: runner image (Agent SDK inside), NDJSON stdio
   protocol, container lifecycle (spawn/reap/resume), DockerRunner in the gateway.
3. **M3 — Streaming & polish**: tool-use status updates in Slack, error surfaces,
   per-user/budget limits, ops docs.

## Gate

`npm run check` = `tsc --noEmit` + `vitest run`. Tests are fake/no-network.
