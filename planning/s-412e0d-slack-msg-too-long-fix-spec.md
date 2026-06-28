# Task: Fix the Slack `msg_too_long` failure — safe text-length margin + graceful handling (412e0d)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is a
worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` first**, then the context below. You are on branch
`sonnet/slack-msg-too-long-fix`.

## Why (context — read before writing code)

A live turn crashed with `:x: Unexpected error: An API error occurred: msg_too_long`.
The error-capture instrumentation (PR #89) revealed the throw origin:
`platformErrorFromResult (@slack/web-api/dist/errors.js)`. So `msg_too_long` is a
**Slack** API error — Slack rejecting a `chat.update`/`chat.postMessage` whose text
exceeds Slack's **40,000-character limit**. (It is NOT an Anthropic context-window
error — all those earlier theories were the wrong service.)

The responder bounds text via `boundSlackText` (`src/slack/responder.ts:39`) to
`SLACK_TEXT_LIMIT = 40000` — but that sits **exactly at Slack's edge**, so a long
agent reply bounded to precisely 40000 chars is still at/over Slack's effective
reject threshold (likely the rendered/counted length, or 40000 is the rejected
boundary). Lowering the cap below the edge prevents it; graceful handling + better
capture make it resilient and diagnosable.

### Grounded facts (verified at current `main`)

- `boundSlackText` + `SLACK_TEXT_LIMIT = 40000` + `MARKER` in
  `src/slack/responder.ts:31-44`. `postPlaceholder`/`updatePlaceholder` (`:47-71`)
  both apply `boundSlackText` — every large-content post funnels through them.
- The Slack client impls (`src/index.ts:47-76`) post `params.text` **raw** — bounding
  is the caller's responsibility.
- **Three direct `this.slack.postMessage({ text })` calls in `manager.ts` bypass
  `boundSlackText`** — `:444` (cap notice, `this.capMessage(...)`), `:535` ("Only
  <@user> can approve…"), `:693` ("Planning expired…"). They post short/fixed text
  today (not the culprit) but should be bounded for consistency.
- `gatewayErrorMeta(err)` (`manager.ts:108-136`, added in #89) extracts
  `name`/`status`/`type`/first-stack-frame — but NOT Slack's error shape. A Slack
  `WebAPIPlatformError` carries `err.code === 'slack_webapi_platform_error'` and
  `err.data.error === 'msg_too_long'` (the specific Slack error code). Grounded:
  confirm the shape in `node_modules/@slack/web-api/dist/errors.d.ts` (a `code`
  enum + a `data` object with `error`/`response_metadata`). Extract defensively.
- The gateway drain catch (`manager.ts:1269-1283`) logs `gatewayErrorMeta(err)` and
  posts `:x: Unexpected error: ${msg}` via the (bounded) `updatePlaceholder`.
- `manager.ts` already imports `postPlaceholder, updatePlaceholder` from
  `../slack/responder.js` — add `boundSlackText` to that import.

## CRITICAL — do not stop after exploration

Make the edits, add tests + update the doc, run `npm run gate`, fix failures, stop.

## Implementation

### 1. Lower the cap below Slack's edge (the primary fix)

In `src/slack/responder.ts`: change `SLACK_TEXT_LIMIT` from `40000` to **`39000`**
(a comfortable margin under Slack's 40,000-char limit). Update the comment to say
"safely below Slack's 40,000-char limit". `boundSlackText`'s logic is unchanged —
it now truncates to ≤39000.

### 2. Bound the 3 stray `manager.ts` postMessage calls

Import `boundSlackText` from `../slack/responder.js`. Wrap the `text` argument of the
three direct `this.slack.postMessage({ … text })` calls (`:444`, `:535`, `:693`)
with `boundSlackText(...)`. No behavioral change for short text; closes the bypass.

### 3. Capture Slack's error code in `gatewayErrorMeta`

Extend the extractor (and its `o` cast) to also read, from `err` and `err.cause`:
`o.code` (string, e.g. `slack_webapi_platform_error`) and `o.data?.error` (string,
the Slack error code, e.g. `msg_too_long`). Append them to the metadata string when
present (e.g. `slackCode=msg_too_long`). These are content-free codes — safe to log.
Do NOT add any message body.

### 4. Graceful user message for a Slack too-long error

Add a small predicate, e.g.:
```ts
/** True if the thrown error is Slack rejecting an over-length message. */
function isSlackMsgTooLong(err: unknown): boolean {
  for (const c of [err, (err as { cause?: unknown })?.cause]) {
    if (c && typeof c === 'object') {
      const o = c as { data?: { error?: unknown } };
      if (o.data?.error === 'msg_too_long') return true;
    }
  }
  return false;
}
```
In the drain catch (`manager.ts:1269-1283`), when `isSlackMsgTooLong(err)`, post a
clear, short message instead of `:x: Unexpected error: <msg>`, e.g.
`:x: That response was too long to post in Slack — try a narrower question.`
(Keep the existing structured-metadata log line; this only changes the user-facing
Slack post for this specific case.) Other errors keep the existing
`:x: Unexpected error: <msg>` behavior.

### 5. Update `docs/errors.md`

The "Known open issue: `msg_too_long`" section is now **resolved** — rewrite it:
`msg_too_long` is a Slack message-length error (not an Anthropic context-window
error); the throw origin (`platformErrorFromResult` in `@slack/web-api`) confirmed
it via the #89 instrumentation; the cap is now `39000` (below Slack's 40k edge), the
gateway catch recognizes it and posts a friendly message, and `gatewayErrorMeta`
logs the Slack code. Follow the `human-prose` skill (strip AI tells). Keep it tight.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`.
2. `SLACK_TEXT_LIMIT === 39000`; `boundSlackText` truncates a >39000 string to
   length ≤ 39000 (test asserts the bound + the marker, and that a ≤39000 string is
   returned unchanged).
3. The three `manager.ts` postMessage calls bound their text via `boundSlackText`.
4. `gatewayErrorMeta` includes the Slack error code for a Slack-shaped error
   (`{ code: 'slack_webapi_platform_error', data: { error: 'msg_too_long' } }`) on
   both `err` and `err.cause`; still emits NO message body.
5. `isSlackMsgTooLong` returns true for the Slack-too-long shape (err and err.cause),
   false otherwise; the drain catch posts the friendly message for it and the generic
   `:x: Unexpected error` otherwise. Test via the existing manager test harness
   (e.g. a runner/Slack fake that throws a Slack-shaped `msg_too_long` while driving).
6. `docs/errors.md` updated to mark `msg_too_long` resolved (human-prose).

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail.
- Never log/audit the error message body — only content-free codes/metadata (the #80
  invariant; `gatewayErrorMeta` already follows it — keep it that way).
- No `any`, no `@ts-ignore`; NodeNext ESM. Suite stays offline (no Slack/Docker/API/
  network — use the existing fakes).
- Don't change `boundSlackText`'s algorithm beyond the limit constant; don't touch
  the runner / `protocol.ts`.
- Don't add dependencies. Don't commit. Don't edit this spec file.
- Doc prose: follow `~/.claude/skills/human-prose/SKILL.md`.

## Out of scope (do NOT build)

- Re-truncate-and-retry on the Slack chokepoint (a retry loop) — the lower cap
  prevents the case; the graceful message + capture handle the residual. Don't build
  the retry.
- Anything about the runner / context window / compaction (wrong service; closed).

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- The tail of `npm run gate` — test count + file count.
- Which Slack error fields you relied on (grounded in `@slack/web-api` types).
- Confirmation no log/audit line gained the message body.
- Any deviation from this spec and why.
