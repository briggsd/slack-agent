# Slackbot ↔ Remote Claude — Architecture (planning sketch)

> This was the pre-build planning sketch. The authoritative, detailed architecture
> document (as built, incl. security model and limitations) is
> [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

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

Shipped:

1. **M1 — Gateway skeleton**: Bolt Socket Mode wiring, session manager, runner
   abstraction with a fake runner, full unit-test coverage. No Docker, no Agent SDK.
2. **M2 — Docker session runner**: runner image (Agent SDK inside), NDJSON stdio
   protocol, container lifecycle (spawn/reap/resume), DockerRunner in the gateway.
   Plus file forwarding (agent-produced files upload to the thread).

Planned — the forward roadmap toward a multi-team internal platform. The *why*
and *shape* of these live in `design/` (`0000` north-star, `0001` capabilities,
`0002` tenancy + durable store, `0003` modes + profiles) and `design/open-questions.md`
(resolved Q1–Q5, parked Q6–Q11). This is the *when*.

3. **M3 — Streaming & polish** *(in flight)*: tool-use status updates in Slack,
   streamed partial text, error surfaces. (Access control / spend limits, first
   sketched here, moved to M6 — see design notes.)
4. **M4 — Seams** *(the keystone; deliberately a near no-op refactor)*: thread
   `team_id` + `user_id` through keys and `QueueItem` (`0002` §1, Q1); the profile
   seam — `profileId` through the entry point and `RunnerFactory.create`, a static
   registry with exactly **one** profile (`0003`); and the **persisted session
   store** (SQLite `sessions` + `audit_events` tables, `0002` §2). Retires
   restart-amnesia. The trace/audit *schema* is decided here (reasoning-level
   traces, `corrections` event, `harness_version`) even though the audit layer
   ships in M6 — those columns can't be retrofitted.
5. **M5 — One-shot repo mode**: the second profile — blueprint orchestration
   (deterministic clone/branch/lint/test/push/PR nodes wrapping agentic subtasks,
   research→plan→implement first, bounded iteration + failure classifier) and the
   **credential broker** (GitHub App short-lived scoped tokens, secrets never enter
   the sandbox). Realizes `0001`. The broker is the headline new component.
6. **M6 — Multi-team hardening**: turn on what M4 recorded — access control + spend
   caps keyed on `team_id`/`user_id`; the **audit layer** (action/cost/corrections
   trail); volume GC via `last_active_at` TTL; and **egress-lock** — the same broker
   gains egress gating + approval-gate enforcement (one choke point, three jobs).
7. **M7 — Scale-out**: prewarm/pool for fast startup; multi-host scheduling behind
   `RunnerFactory` (or Managed Agents). Forward-looking opportunities (knowledge
   flywheel Q11, measurement-driven versioning Q10) become possible on M4's schema.

## Gate

`npm run check` = `tsc --noEmit` + `vitest run`. Tests are fake/no-network.
