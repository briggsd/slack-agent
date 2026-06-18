# CLAUDE.md — runner/ (the sandbox side)

This package is what runs **inside each Docker container** — one per Slack thread.
It drives the Claude Agent SDK and speaks the NDJSON protocol to the gateway over
stdin/stdout. It is the untrusted-ish zone: the agent runs here with full tool
access, confined by the container. See the root `CLAUDE.md` and
`docs/ARCHITECTURE.md` first.

## Local rules that bite here

- **`src/protocol.ts` must stay byte-identical to `../src/runner/protocol.ts`**
  (the gateway's copy). This is the contract between the two processes. If you add
  or change a message type, edit *both* copies in the same change, or the gateway
  and container disagree silently.

- **Ground every Agent SDK call in the real type definitions — don't recall the
  API.** Before writing code that calls `@anthropic-ai/claude-agent-sdk`, read its
  `.d.ts` in `node_modules/@anthropic-ai/claude-agent-sdk/` and use only symbols
  you can point to there. The shape is roughly a `query({ prompt, options })`
  async generator with a `resume`/session-id mechanism and system-init / assistant
  / result message types — but the `.d.ts` is the source of truth, not this
  sentence. If the real API differs, follow the real API and note it.

- **The container is the permission boundary, so the SDK runs with
  `permissionMode: 'bypassPermissions'`.** That is intentional — the agent
  auto-approves its own tool use because the sandbox, not a prompt, is what
  contains it. Don't "fix" this by adding in-process permission prompts.

- **Keep the runner's main loop injectable.** fs and SDK functions are passed in so
  the loop is testable with `FakeAgentSdk` and no real container, network, or API.
  Preserve that seam in new code (`test/runner-main.test.ts`).

- **Never log message contents or tokens** — same rule as the gateway.

## Checks

This package has its own `npm run check` (tsc over `runner/`), which the root
`npm run check` invokes. Run the root gate before declaring done; it covers both.

## Build

The image is built from `runner/Dockerfile` (`node:22-bookworm-slim`, non-root
user, includes `git`/`curl`/`ripgrep`). Rebuild it whenever `runner/` changes:
`docker build -t slackbot-runner runner/`. `scripts/smoke-docker.sh` does a real
end-to-end container round-trip — useful after Dockerfile or protocol changes, but
it is **not** part of the CI gate (it needs Docker + an API key).
