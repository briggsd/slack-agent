# slackbot

A Slack gateway for Claude sessions. Each Slack thread maps to its own Claude Agent SDK session running in an isolated, on-demand Docker sandbox; agent-generated files are uploaded back into the thread.

**→ Detailed architecture, security model, limitations, and operational notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Prerequisites

- Node 20+
- A Slack workspace where you can create apps

## Setup

### 1. Create a Slack app

Go to https://api.slack.com/apps and click **Create New App → From manifest**.

Paste the manifest below (YAML):

```yaml
display_information:
  name: claude-bot
features:
  bot_user:
    display_name: claude-bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### 2. Enable Socket Mode

In your app settings → **Socket Mode** → toggle on. Generate an **App-Level Token** with scope `connections:write`. Copy the token (starts with `xapp-`).

### 3. Install the app to your workspace

Go to **OAuth & Permissions** → **Install to Workspace**. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in SLACK_BOT_TOKEN and SLACK_APP_TOKEN
```

### 5. Build and run

```bash
npm install
npm run build
npm start
```

The bot connects to Slack over Socket Mode. With the default `RUNNER_BACKEND=fake`
it answers with a stubbed runner — enough to confirm the Slack wiring (mention to
start a thread, reply to continue it) without Docker or an API key. For real Claude
sessions, set up the Docker backend (see [Sandbox runner](#sandbox-runner)).

## How you talk to it

- **Mention the bot** (`@claude-bot …`) in a channel it's in, or DM it, to start a
  thread. Each thread is one Claude Agent SDK session in its own sandbox; reply in
  the thread to continue the conversation.
- Inside a conversational thread the agent has a set of gateway-served tools — clone
  a repo, run lint/test checks, provision a runtime, open / edit / comment on a PR,
  and read an issue. What each does and how to add a new one is in
  [docs/toolshed.md](docs/toolshed.md).
- For a one-shot "go fix this repo and open a PR" task, use the `task` / `exec`
  keywords (see [One-shot repo tasks](#one-shot-repo-tasks)).

## Development

First checkout installs **both** packages (the gateway and the sandbox `runner/`),
or the runner type-check can't resolve the Agent SDK:

```bash
npm ci && npm --prefix runner ci
```

The test suite is fully offline — no Slack, no Docker, no API, no network.

```bash
# Fast inner loop: tsc + the runner package's type-check + vitest
npm run check

# What CI runs: the above plus the dependency-cruiser architecture rules
npm run gate

# Just the tests
npm test
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | yes | — | App-Level Token for Socket Mode (`xapp-…`) |
| `IDLE_TIMEOUT_MS` | no | `600000` | Milliseconds before an idle session runner is reaped |
| `SESSION_DB_PATH` | no | `.data/sessions.db` | Path to the SQLite session DB; parent dir is auto-created; mount on a persistent volume in production |
| `SPEND_CAP_PER_TASK_USD` | no | `20` | Lifetime spend cap per session/thread, in USD. `0` disables it. A thread at or over this is stopped ("start a new thread to continue") |
| `SPEND_CAP_PER_USER_24H_USD` | no | `100` | Rolling 24-hour spend cap per user, in USD. `0` disables it |
| `SPEND_CAP_GLOBAL_24H_USD` | no | `400` | Rolling 24-hour workspace-wide spend cap, in USD. `0` disables it |

## Sandbox runner

In production (`RUNNER_BACKEND=docker`) each Slack thread gets its own Docker
container running the Claude Agent SDK. Containers speak the NDJSON protocol
over stdio and persist agent state on a named Docker volume, enabling
*resume-after-reap*: when a session's container is reaped due to inactivity
the next message transparently restarts a new container and resumes the SDK
session from the saved session ID.

### Build the image

```bash
docker build -t slackbot-runner runner/
```

The image is based on `node:22-bookworm-slim`, runs as a non-root user,
and includes `git`, `curl`, and `ripgrep` as agent tools.

### Required environment

| Variable | Required for docker | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Passed to each container via `-e ANTHROPIC_API_KEY` (value never appears in `docker` argv) |
| `RUNNER_IMAGE` | no (default `slackbot-runner:latest`) | Docker image to run |
| `RUNNER_BACKEND` | no (default `fake`) | Set to `docker` to enable real containers |
| `PLANNING_IDLE_TIMEOUT_MS` | no (default 4h) | How long an idle conversational planning session is kept alive before posting an expiry notice and reaping its container. |
| `GITHUB_BOT_TOKEN` | no | Bot-account token for one-shot GitHub repo tasks. Stays gateway-side; never enters the agent sandbox. Without it, a `task`/`exec github:…` mention errors. |
| `GATE_TIMEOUT_MS` | no (default 15 min) | How long a supervised (`task`) run waits at the plan-approval gate for a reply before abandoning. |
| `GITLAB_BOT_TOKEN` | no | Same, for GitLab (provider not yet implemented). |
| `GIT_IMAGE` | no (default `slackbot-runner:latest`) | Image for the ephemeral credentialed git nodes (clone/push) |
| `CLONE_REPO_ALLOWLIST` | no (default empty) | Comma-separated exact GitHub `owner/name` slugs the conversational `clone_repo` tool may clone. Empty/unset denies model-chosen clones. |
| `RUNTIME_CATALOG_PATH` | no (default `config/runtimes.json`) | JSON catalog of pinned relocatable runtimes available to `provision_runtime`. Missing/empty catalog denies all runtime requests; malformed entries fail startup. |
| `VOLUME_TTL_MS` | no (default 7 days) | Inactivity before a session's workspace volume + row are garbage-collected |
| `VOLUME_GC_INTERVAL_MS` | no (default 1 hour) | How often the volume-GC sweep runs |

This table covers the common knobs; `.env.example` is the complete, annotated reference
(container resource limits, per-turn timeouts, one-shot check-command overrides, …).

> Upgrade note: conversational `clone_repo` is deny-by-default. Existing deployments
> that rely on the coordinator cloning repositories must set `CLONE_REPO_ALLOWLIST`;
> otherwise clone attempts return `repo not allowed`. Entries must be bare
> `owner/name` slugs, not URLs or `.git` URLs; malformed entries fail startup.

The conversational runner also exposes `mcp__commit__provision_runtime` for
missing toolchains. The model can name only a catalog runtime such as `python`;
the gateway resolves that name to the pinned URL and SHA256 in
`config/runtimes.json`, downloads it in an ephemeral no-credential container,
verifies the checksum, and extracts it onto the session volume under
`/workspace/.runtimes`. `run_checks` prepends provisioned runtime `bin`
directories to `PATH`.

## One-shot repo tasks

Mention the bot with a leading keyword and a `host:owner/repo` target to run a
one-shot repo task. Two keywords, differing only in whether a human signs off on
the plan:

```
@slackbot task github:owner/repo fix the flaky login test in auth.spec.ts   # supervised
@slackbot exec github:owner/repo bump the changelog for the 1.4 release      # fire-and-forget
```

Either way the bot clones the repo, researches it, and writes an implementation
plan; then it implements the change, pushes a branch, and replies with a
pull-request link. The git credential never enters the agent sandbox — only the
gateway-side deterministic git nodes carry it (see `docs/ARCHITECTURE.md`).

**`task` — supervised.** The run pauses after planning and posts the plan to the
thread. Nothing is written until you respond in-thread:

- `approve` (or `approved`) — proceed: implement → push → open a PR.
- `cancel` / `abort` / `reject` — abandon now; nothing is pushed.
- anything else — treated as feedback; the bot revises the plan and asks again.
- no reply within `GATE_TIMEOUT_MS` (default 15 min) — abandon.

**`exec` — fire-and-forget.** No gate; the plan flows straight into implementation.

> **Heads-up — who can start a credentialed run.** The gate is *supervision*, not an
> invocation gate: only the thread's originator can approve/cancel/redirect a run
> (requestor-only), but the gateway does **not** gate *who may start* one per-user.
> Invocation is controlled **operationally, at Slack**: the bot only receives events
> from channels it's a member of, so keep it in channels whose membership you trust
> (ideally private) and out of `#general`. Anyone in a bot-occupied channel can start a
> run — spending API budget (bounded by the `SPEND_CAP_*` caps above) and opening a PR. That's an accepted
> trade-off because the real control is downstream: every run ends at "open a PR", which
> a human reviews and merges on GitHub — **the bot never merges**, and agent code only
> ever runs inside the sandbox container, never on the host. So an unwanted PR is a
> `gh pr close`, not an incident. A gateway channel/user allow-list is a possible future
> tightening if channel trust isn't enough.

One-shot is fully faked under `RUNNER_BACKEND=fake` (a stub PR link, no real git),
so it only touches real repos under `RUNNER_BACKEND=docker` with a
`GITHUB_BOT_TOKEN` configured. See `.env.example` for the full list of settings.

### Resume-after-reap

The runner persists the SDK session ID to `/workspace/.slackbot/session-id`
inside the container. `/workspace` is a named Docker volume
(`slackbot-ws-<sanitized-session-key>`), which survives container restarts.
On the next container start the runner reads the file and passes
`resume: <session-id>` to `query()`, continuing the conversation from where
it left off.

**Note — volume garbage collection**: a periodic sweep removes a session's
workspace volume *and* its session row after `VOLUME_TTL_MS` of inactivity
(default 7 days; sweep interval `VOLUME_GC_INTERVAL_MS`, default 1 hour). Live
sessions are skipped. `docker volume prune` remains a manual fallback for volumes
left behind by an unclean shutdown.

**Note — SQLite state files**: the session store runs in WAL mode, so three files
are written: `.db`, `.db-wal`, and `.db-shm`. Back up all three together, or use
`sqlite3 <db-path> ".backup <dest>"` for a consistent snapshot.

### File forwarding

Files the agent saves under `/workspace` during a turn are automatically
uploaded to the Slack thread at the end of that turn. The agent is instructed
to save artifacts (SVGs, CSVs, PDFs, etc.) there so they reach the user.

Limits per turn: up to **5 files**, max **8 MiB per file**, max **16 MiB total**.
Files that exceed a cap are skipped and a note is posted to the thread.

The Slack app requires the **`files:write`** bot scope for uploads.

### Smoke test

```bash
# Requires ANTHROPIC_API_KEY and a running Docker daemon
bash scripts/smoke-docker.sh
```

This is NOT part of the CI gate. It builds the image, starts a real container,
and sends one message end-to-end.

## Architecture

- **As-built system** — security model, trust boundaries, lifecycle, limitations:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Tool system** — the two kinds of tool, how a gateway-served tool's round trip
  works, and the steps to add one: [docs/toolshed.md](docs/toolshed.md)

(`planning/ARCHITECTURE.md` is the original pre-build sketch, kept for history;
`docs/ARCHITECTURE.md` is authoritative.)
