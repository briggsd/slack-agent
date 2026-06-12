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

## Architecture

See `planning/ARCHITECTURE.md` for the full design.
