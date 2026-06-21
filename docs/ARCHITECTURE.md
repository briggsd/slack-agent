# Slackbot Architecture

A multi-user Slack bot where **each Slack thread is an independent Claude agent session**
running in **its own on-demand Docker sandbox**. Many threads can be active concurrently;
each is isolated from all the others.

This document covers the architecture in depth: components, lifecycles, the concurrency
and memory models, security boundaries, limitations, and operational considerations.
For the quick-start (Slack app manifest, env setup), see the [README](../README.md).

---

## 1. System overview

```
                Slack workspace
                      │
                      │  websocket (Socket Mode — no public URL needed)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Gateway — one Node.js process (src/)                        │
│                                                             │
│  slack/listener.ts    event routing (mention / thread reply)│
│  slack/responder.ts   placeholder post + in-place updates   │
│  sessions/manager.ts  sessionKey → Session, FIFO, idle reap │
│  runner/docker.ts     container lifecycle + protocol client │
└──────────┬──────────────────────┬───────────────────────────┘
           │ docker run -i        │ docker run -i
           ▼                      ▼
┌─────────────────────┐  ┌─────────────────────┐
│ Container: thread A │  │ Container: thread B │   … one per active thread
│  runner/main.js     │  │  runner/main.js     │
│  Claude Agent SDK   │  │  Claude Agent SDK   │
│  /workspace ◄─vol A │  │  /workspace ◄─vol B │
└─────────────────────┘  └─────────────────────┘
```

Three layers:

| Layer | Code | Role |
|---|---|---|
| **Gateway** | `src/` | Single trusted process. Talks to Slack, owns session bookkeeping, spawns/reaps containers. Never runs agent code itself. |
| **Protocol** | `src/runner/protocol.ts` ≡ `runner/src/protocol.ts` | Newline-delimited JSON over the container's stdin/stdout. The only channel between gateway and sandbox. |
| **Runner** | `runner/` | Untrusted-ish sandbox. One per session. Runs the Claude Agent SDK (the Claude Code engine) with full tool access *inside* the container. |

### Key design decisions (and why)

- **Socket Mode** — the gateway dials out to Slack over a websocket, so it runs anywhere
  (behind NAT/WSL2) with no public HTTPS endpoint. The trade-off: not usable for Slack
  Marketplace distribution, and it's a single consumer per app token.
- **Agent SDK in the container, not the gateway** — the SDK executes tools (bash, file
  edits) *locally to wherever it runs*. Running it in the gateway would give every thread
  shell access to the host. Running it in the container makes the blast radius one
  throwaway sandbox.
- **`docker run -i` + stdio, not HTTP** — one long-lived process per session with NDJSON
  over stdin/stdout means no port allocation, no service discovery, and container death is
  trivially observable (the pipe closes).
- **Docker CLI via `child_process`, not dockerode** — one fewer dependency; the CLI is the
  stable interface, and the spawn call is injectable for tests.

---

## 2. Session model

### Session key

```
sessionKey = `${channel}:${thread_ts ?? ts}`
```

A top-level @mention starts a thread; its `ts` becomes the thread's `thread_ts`, so all
replies in that thread map to the same key. One key ⇒ one session ⇒ one container ⇒ one
volume ⇒ one Agent SDK conversation.

### Event routing rules (`src/slack/listener.ts`)

| Incoming event | Behavior |
|---|---|
| `app_mention` (anywhere) | Create **or reuse** the session for that thread; enqueue the text (mention stripped). This is the only way a session is born. A leading `task `/`exec ` keyword + `host:owner/repo` target instead selects a one-shot repo profile (clone → research → plan → implement → push → open PR): `task` → `supervised-repo-oneshot` (pauses at a plan-approval gate); `exec` → `repo-oneshot` (fire-and-forget). The keyword is stripped and the rest is the instruction. |
| `message` that is a thread reply | Route to the session for that thread **only if one exists**; otherwise ignored silently. If that run is parked at a plan-approval gate, the reply resolves the gate (approve / cancel / revise) instead of starting a new turn. |
| `message` that mentions the bot | Ignored by the message handler — Slack also fires `app_mention` for it, and processing both would answer twice. |
| Anything with `bot_id` or a `subtype` (edits, deletes, bot posts) | Ignored. Prevents the bot replying to itself / reacting to edits. |

### Container & volume naming

The session key is sanitized (`[^a-z0-9-]` → `-`, lowercased, 64-char cap) into:

- container: `slackbot-<sanitized-key>` (ephemeral, `--rm`)
- volume: `slackbot-ws-<sanitized-key>` (persistent)

---

## 3. Lifecycle of a message (end to end)

1. User posts `@bot draw me an SVG` in a thread.
2. Slack delivers `app_mention` over the websocket. The listener computes the session key
   and enqueues the message.
3. `SessionManager` finds no live session → `DockerRunnerFactory.create()`:
   `docker run --rm -i --name slackbot-… -v slackbot-ws-…:/workspace -e ANTHROPIC_API_KEY
   --memory … --cpus … --pids-limit … --security-opt no-new-privileges slackbot-runner`.
4. The runner boots, loads a persisted SDK session id from
   `/workspace/.slackbot/session-id` if one exists, and prints `{"type":"ready"}`.
   The gateway waits for this handshake (30 s timeout) before sending anything.
5. The gateway posts a `_thinking…_` placeholder reply in the thread, then writes
   `{"type":"user_message","id":…,"text":…}` to the container's stdin.
6. Inside the container the runner calls the Agent SDK (`query()` with
   `permissionMode: 'bypassPermissions'`, `cwd: /workspace`, `resume: <session id>` when
   present, and a system-prompt addition explaining that saved files reach the user). The
   agent may run bash, write files, etc. — all confined to the container.
7. As the SDK reports tool use, the runner emits `status` lines; the gateway edits the
   placeholder in place (`using tool: Bash`, …).
8. On completion the runner scans `/workspace` for files modified during the turn and
   emits them as base64 `file` messages (caps: 5 files, 8 MiB each, 16 MiB total),
   then the final `text`.
9. The gateway uploads each file into the thread (`files.uploadV2`) and replaces the
   placeholder with the final answer text.
10. After `IDLE_TIMEOUT_MS` (default 10 min) without activity, the reaper disposes the
    runner: stdin is closed, SIGTERM sent, and after a grace period the container is
    force-killed by name (`docker kill`). The volume remains, so the next message can
    resume the workspace — until volume GC removes it (step 12).
11. The next message in that thread repeats from step 3 — the new container resumes the
    SDK session from the volume, so conversational memory is intact.
12. A periodic in-process sweep (`VOLUME_GC_INTERVAL_MS`, default 1 h) removes the volume
    and deletes the session row once a session has been idle past `VOLUME_TTL_MS`
    (default 7 days); a session still live in memory is always skipped, so an in-use
    volume is never removed.

### Failure paths

- **Turn timeout** (default 5 min): the gateway yields an error event, the placeholder
  shows a readable error, and the session stays usable.
- **Container dies mid-turn**: the pipe closes; the in-flight turn gets an error event.
  A broken-pipe write cannot crash the gateway (stdin error handler).
- **Per-message SDK errors / malformed protocol lines**: surfaced as error events, never
  process crashes — the runner answers the *next* message normally.
- **Upload failure** (`files.uploadV2`): noted in the thread; the text reply still lands.

---

## 4. Concurrency model

- **Serial within a thread.** Each session drains its queue one message at a time (FIFO).
  Rapid follow-ups in one thread queue up and are answered in order — and because the SDK
  session is sequential, each answer sees the previous one.
- **Parallel across threads.** Sessions are independent: separate containers, separate
  queues. Concurrency is bounded only by host resources (each container defaults to
  0.5–1 CPU / 512 MiB; see config).
- **No reap mid-turn.** The idle reaper skips a session whose turn is in flight and
  re-arms its timer — a long agent run can't have its container killed under it.

---

## 5. Memory & isolation model

| Scope | What persists | Where |
|---|---|---|
| Within a turn | Everything the agent does | Container + volume |
| Across turns in a thread | Full conversation (SDK transcript) + all files in `/workspace` | Named volume (`HOME=/workspace`, so SDK state lands there too) |
| Across container reaps / gateway restarts / host reboots | Same — the volume is the durable unit | Named volume |
| **Across threads** | **Nothing.** Different key ⇒ different volume ⇒ different SDK session. No shared filesystem or transcript. | — |

Caveat after a **gateway restart**: the in-memory session map is empty, so plain (un-mentioned)
replies in old threads are ignored until someone @mentions the bot in that thread again —
at which point the volume-backed session resumes with full history.

If cross-thread memory is ever wanted, the safe shapes are a shared **read-only** mount
(team knowledge) or a **per-user** read-write volume keyed on Slack user id. A fully shared
writable memory would let any user's thread influence every other user's context — avoid.

---

## 6. Security model

### What the sandbox provides

- Agent code (bash, file writes, anything the model decides to run) executes in a
  container as a **non-root user**, with `--security-opt no-new-privileges`,
  `--pids-limit`, `--memory`, and `--cpus` caps.
- The filesystem blast radius is the container layer + that one thread's volume.
- The API key is passed via `-e ANTHROPIC_API_KEY` env inheritance — it never appears in
  `docker` argv (visible in `ps`) or in logs. Slack tokens never enter containers at all.
- Message contents are never logged by gateway or runner; logs carry keys, lifecycle
  events, filenames and sizes only.

### What it does NOT provide (be aware)

- **Network egress is open.** Containers run on the default bridge network — required for
  the Agent SDK to reach the Anthropic API, but it also means a prompt-injected agent can
  call out anywhere. Hardening option: a custom Docker network with an egress proxy
  allow-listing `api.anthropic.com`.
- **The agent holds the API key.** Anything inside the container — including code the
  model writes — can read `ANTHROPIC_API_KEY`. Use a dedicated, spend-capped key for the
  bot, not an org-wide one.
- **`bypassPermissions`.** The agent auto-approves its own tool use. That's the point of
  the sandbox (the container is the permission boundary), but it means *within* the
  sandbox the agent is unrestricted.
- **Container ≠ VM.** Docker isolation is kernel-level. Fine for "mutually trusting
  workspace members, defense against agent mistakes and prompt injection"; not the right
  tool for running truly hostile tenants. For hard multi-tenant isolation, use microVMs
  (Firecracker/Kata) or Anthropic's hosted Managed Agents sandboxes.

### Trust boundaries

```
Slack users ──(can prompt the agent)──► container       ← untrusted zone
Gateway ──(spawns, parses NDJSON)────► host             ← trusted zone
```

The gateway treats everything from the container as data: protocol lines are parsed
defensively (malformed JSON skipped; bad base64 → skipped file), and nothing from the
container is ever executed on the host.

---

## 7. Slack app requirements & configuration

### Slack app (current working set)

- **Socket Mode** enabled; app-level token with `connections:write`.
- **Bot scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `files:write`.
  Add `groups:history` / `im:history` (+ matching event subscriptions) for private
  channels / DMs. *Scope changes require an app reinstall* — a missing
  `message.channels` subscription or `channels:history` scope silently disables
  un-mentioned thread replies (events are simply never delivered).
- **Event subscriptions** (bot events): `app_mention`, `message.channels`
  (+ `message.groups`, `message.im` if private/DM support is wanted).

### Environment (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | — | Bot (`xoxb-`) and app-level (`xapp-`) tokens |
| `ANTHROPIC_API_KEY` | — | Passed into each container; fund/spend-cap accordingly |
| `RUNNER_BACKEND` | `fake` | `fake` = echo bot (no Docker); `docker` = real sandboxes |
| `RUNNER_IMAGE` | `slackbot-runner:latest` | Built from `runner/Dockerfile` |
| `IDLE_TIMEOUT_MS` | 600000 (10 min) | Reap idle sessions after this |
| `VOLUME_TTL_MS` | 604800000 (7 days) | Volume GC: a session idle longer than this has its volume and session row removed |
| `VOLUME_GC_INTERVAL_MS` | 3600000 (1 h) | How often the volume-GC sweep runs |
| `RUNNER_READY_TIMEOUT_MS` | 30000 | Container boot handshake deadline |
| `RUNNER_TURN_TIMEOUT_MS` | 300000 (5 min) | Per-message deadline |
| `RUNNER_KILL_GRACE_MS` | 5000 | SIGTERM → force-kill grace |
| `RUNNER_MEMORY` / `RUNNER_CPUS` / `RUNNER_PIDS_LIMIT` | `512m` / `1.0` / `256` | Per-container caps |
| `GITHUB_BOT_TOKEN` / `GITLAB_BOT_TOKEN` | — | Bot-account tokens for one-shot repo tasks. Held gateway-side; carried only by the deterministic git nodes, never injected into the agent sandbox. Under `RUNNER_BACKEND=fake` the broker is faked and these are unused. |
| `GIT_IMAGE` | `slackbot-runner:latest` | Image for the ephemeral credentialed git nodes (clone/push) |
| `CLONE_REPO_ALLOWLIST` | empty | Comma-separated exact GitHub `owner/name` slugs the conversational `clone_repo` tool may clone. Empty/unset denies model-chosen clones before leasing or spawning Docker; malformed entries fail startup. |

---

## 8. Limitations & known gaps

| Area | Current state |
|---|---|
| **Access control (invocation)** | Gated **operationally, at Slack** — the bot only receives events from channels it is a member of, so channel membership is the invocation boundary: keep the bot in trusted (ideally private) channels and out of `#general`. The gateway intentionally does **not** add a per-user invocation allow-list (decided M6: the bot only opens PRs — never merges — and agent code runs only in the sandbox, so an unwanted PR is reversible; a gateway channel/user allow-list is a documented future tightening). **Spend caps / rate limits are still absent** (separate M6 work) — channel-scoping only coarsely limits who can burn API budget. |
| **Plan gate is supervision, not an invocation gate** | A `task` run pauses for a human to approve the plan. Resolution is **requestor-only**: only the user who started the thread may approve, cancel, or revise it — a reply from anyone else is rejected with a notice, and it fails closed (no one resolves) when the requestor is unknown. It is supervision, not an *invocation* boundary: anyone who can mention the bot can still start a run. The real control is downstream — every run ends at *open a PR*, which a human reviews and merges on GitHub (the bot never merges), so a real `GITHUB_BOT_TOKEN` is safe to the extent you trust branch-protection and review on the repos the token covers. Who may *invoke* is gated operationally via Slack channel membership (see Access control above), not by a gateway allow-list. |
| **Parked gates are in-memory** | A run paused at the plan gate lives in the gateway's memory. A gateway restart mid-park loses the parked run (the workspace volume is still safe); durable park is deferred. |
| **Streaming** | The thread shows `_thinking…_` → tool-status edits → one final text. Partial answer text is not streamed. (Planned M3.) |
| **Long answers** | Final text goes through `chat.update`; Slack caps messages at ~40k chars (practically ~4k rendered well). Very long answers should be chunked or uploaded as a file — not yet handled. |
| **Volume GC** | A periodic in-process sweep removes a session's volume (`slackbot-ws-*`) and its session row once idle past `VOLUME_TTL_MS` (default 7 days); live in-memory sessions are skipped. Tune the cadence with `VOLUME_GC_INTERVAL_MS` (default 1 h). |
| **Gateway restart amnesia** | In-memory session map is lost; old threads need a fresh @mention to resume (state itself is safe on the volume). A persisted thread→session index would fix this. |
| **Capacity** | One host. Each active thread is a container; ~dozens of concurrent threads on a typical box. Scaling past one machine means a scheduler or Anthropic Managed Agents. |
| **Turn deadline vs long agent runs** | A single turn exceeding `RUNNER_TURN_TIMEOUT_MS` (5 min) is reported as an error even though the agent may still finish internally; the result is then lost from Slack's view. |
| **File forwarding heuristics** | Anything modified under `/workspace` during a turn (minus dotfiles/`node_modules`/symlinks) is forwarded — the agent writing scratch files can produce noise; conversely files >8 MiB are skipped with a notice. |
| **Sanitized-key collisions** | Two distinct session keys could in theory sanitize to the same container/volume name (64-char truncation); not a practical concern for `channel:ts` keys, but don't reuse the scheme for arbitrary strings. |
| **No inbound files** | Files users attach in Slack are not delivered into the sandbox. |
| **Public channels only (today)** | Private channels/DMs need extra scopes + event subscriptions (see §7). |

---

## 9. Operational notes

- **Run**: `docker build -t slackbot-runner runner/ && npm run build && npm start`.
  Rebuild the image whenever `runner/` changes; restart the gateway whenever `src/` changes.
- **Logs**: gateway stdout carries lifecycle lines (`[listener] mention → session=…`,
  `[session] reaping idle session: …`); container stderr is forwarded to gateway stderr
  prefixed by the runner. No message contents anywhere.
- **Health**: `docker ps --filter name=slackbot-` shows active sessions;
  `docker volume ls --filter name=slackbot-ws-` shows every thread that ever lived.
- **Cost model**: each thread turn is an Agent SDK run (multiple model calls for tool
  loops). The per-thread transcript grows over time and is re-sent on each turn (the SDK
  manages context/compaction internally). Idle threads cost nothing — only the volume's
  disk.
- **Upgrade path**: if one host stops being enough, the gateway's `RunnerFactory`
  abstraction is the seam — a remote-scheduler factory (or one backed by Anthropic's
  hosted **Managed Agents** sandboxes) can replace `DockerRunnerFactory` without touching
  the Slack layer.

---

## 10. Testing strategy

The entire suite (300+ tests) runs offline in <2 s — no Slack, no Docker, no API:

- **Seams everywhere**: Bolt is only imported in `src/index.ts`; handlers take a minimal
  `SlackClientLike`; `DockerRunner` takes an injectable `spawn`; the runner's main loop
  takes injectable fs/SDK functions.
- **Capture fakes**: `FakeSlackClient` (posts/updates/uploads), `FakeChildProcess`
  (PassThrough stdio), `FakeRunner` (scripted turns with manually-released gates),
  `FakeAgentSdk` (scripted SDK event streams).
- **What unit tests can't catch** (each found live, now documented): CJS/ESM interop in
  the one Bolt import; Dockerfile build ordering; Slack app scope/subscription config.
  Mitigations: `scripts/smoke-docker.sh` (real container round-trip) and a real
  `docker build` before shipping runner changes.

---

*Status: M1 (gateway) + M2 (Docker runner) + file forwarding + M5 (one-shot repo tasks:
broker, credentialed git nodes, blueprint engine) shipped and verified live. M6 in progress:
the `task` plan-approval gate (supervised one-shot) is shipped and smoke-verified, with
requestor-only gate resolution, the audit-events layer, and volume GC. Invocation authz is
handled operationally (Slack channel-scoping), not in the gateway. Remaining M6 work: spend
caps / rate limits, egress-lock, and durable park across restart. Other open gaps: streaming,
restart-surviving session index. See `planning/` for milestone specs.*
