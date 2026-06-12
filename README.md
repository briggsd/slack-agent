# slackbot

A Slack gateway for Claude sessions. Each Slack thread maps to its own isolated runner session. In M1 a `FakeRunner` echoes messages; M2 wires in a real Docker-based Claude Agent SDK runner.

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

The bot will connect via Socket Mode and echo any message directed at it.

## Development

```bash
# Type-check + run tests
npm run check

# Just tests
npm test
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | yes | — | App-Level Token for Socket Mode (`xapp-…`) |
| `IDLE_TIMEOUT_MS` | no | `600000` | Milliseconds before an idle session runner is reaped |

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

See `.env.example` for the full list of tunable settings.

### Resume-after-reap

The runner persists the SDK session ID to `/workspace/.slackbot/session-id`
inside the container. `/workspace` is a named Docker volume
(`slackbot-ws-<sanitized-session-key>`), which survives container restarts.
On the next container start the runner reads the file and passes
`resume: <session-id>` to `query()`, continuing the conversation from where
it left off.

**Note — volume garbage collection**: Docker volumes accumulate one per Slack
thread and are never automatically removed. Run `docker volume prune` (or a
scheduled cleanup script) to reclaim disk space from old sessions.

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

See `planning/ARCHITECTURE.md` for the full design.
