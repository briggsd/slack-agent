# Task: Bound responder text to Slack's 40k-char limit so a long reply can't crash the turn

You are implementing one slice in `/Users/jedanner/workspace/slack-agent`
(TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root `CLAUDE.md`
first** (gate, invariants, conventions), then the context below. You are on branch
`sonnet/63562c-responder-length`. The worktree is at
`/Users/jedanner/workspace/sa-wt-sonnet-63562c-responder-length` — do all work there.

## Context — read before writing code

A real Slack run (2026-06-27) crashed a turn: the agent produced a long reply, the
gateway posted it straight into Slack's `chat.update` `text` field with **no length
guard**, Slack's text limit is **40,000 chars**, so it returned `msg_too_long`. That
error escaped the per-message handler, so the `_thinking…_` placeholder was **never
replaced** — the user saw a hung placeholder with no explanation. The same unbounded
text also flows through the **error-surfacing** path (`:x: Error: …`), whose message
can itself be a relayed-from-container string that exceeds 40k — so the *error* post
can re-trigger `msg_too_long` and re-strand the placeholder.

The fix is a single length-bound at the **one responder chokepoint** every
agent-relayed text funnels through.

- **The seam to fix:** `src/slack/responder.ts`. It exposes the injected
  `SlackClientLike` interface plus two helpers:
  - `postPlaceholder(slack, channel, threadTs)` → calls `slack.postMessage({ text })`.
  - `updatePlaceholder(slack, placeholder, text)` → calls `slack.update({ text })`.
- **Why this seam covers the dangerous paths:** in `src/sessions/manager.ts`, the
  agent's reply and the error notice both reach Slack through `updatePlaceholder`:
  - The reply text path: `tryUpdate(event.text)` (manager.ts ~line 765) →
    `updatePlaceholder`.
  - The error-surfacing path: `tryUpdate(`:x: Error: ${event.message}`)`
    (manager.ts ~line 955) → `updatePlaceholder`. `event.message` for a
    `runner_error` is relayed verbatim from inside the container and is unbounded.
  - The gate/approval prompts (`tryUpdate(formatBuildSpecApprovalPrompt(...))`,
    the timeout-note `updatePlaceholder(...)` at ~line 1311) also funnel through the
    same two helpers.
  So bounding inside `updatePlaceholder` + `postPlaceholder` bounds **every**
  agent-relayed/untrusted text without touching `manager.ts`. (The other direct
  `this.slack.postMessage(...)` calls in `manager.ts` — cap notices, "Only X can
  approve", "Planning expired" — are fixed short gateway strings well under 40k and
  are **out of scope**; do not touch them.)

- **Existing test:** `test/responder.test.ts` already has a `FakeSlackClient`
  (records `posts` / `updates` / `uploads`) and tests for both helpers. **Add your
  new assertions to this file using that existing fake** — it is exported from the
  same file; do not write a new fake.

## CRITICAL — do not stop after exploration

Do NOT pause, summarize, or yield until the task is fully implemented AND the gate
passes. Make every edit, add tests, run the gate, fix failures, then stop. Yielding
after only exploring (zero file changes) is a failure — implement end to end in this
run.

## Acceptance criteria

1. `npm run gate` passes (all existing tests keep passing, plus the new ones; tsc +
   runner type-check + vitest + boundaries all green).
2. **New exported pure helper** in `src/slack/responder.ts`:
   `export function boundSlackText(text: string): string`.
   - Define `export const SLACK_TEXT_LIMIT = 40000;` (the Slack `text` cap) in the
     same file and use it.
   - If `text.length <= SLACK_TEXT_LIMIT`, return `text` **unchanged** (identity —
     not a copy with a marker).
   - If `text.length > SLACK_TEXT_LIMIT`, return a string of length **exactly
     `SLACK_TEXT_LIMIT`** consisting of a truncated prefix of `text` followed by a
     fixed marker `\n\n…[truncated]`. I.e. `text.slice(0, SLACK_TEXT_LIMIT -
     MARKER.length) + MARKER`, where `const MARKER = '\n\n…[truncated]';`. The result
     must end with the marker and have `.length === SLACK_TEXT_LIMIT`.
3. `postPlaceholder` and `updatePlaceholder` apply `boundSlackText(...)` to the
   `text` they pass to `slack.postMessage` / `slack.update`. (Bounding the tiny
   `_thinking…_` placeholder is a harmless no-op via the identity branch — keeping
   the seam uniformly safe is the point; do it anyway.)
4. **New tests** in `test/responder.test.ts`, using the existing `FakeSlackClient`:
   - `boundSlackText` returns short text unchanged (identity) — a normal reply and an
     empty string both pass through verbatim.
   - `boundSlackText` truncates a `> 40000` char input to exactly `SLACK_TEXT_LIMIT`
     chars, the result ends with `\n\n…[truncated]`, and a prefix of the original
     survives (e.g. the first 100 chars are preserved).
   - A boundary case: input of exactly `SLACK_TEXT_LIMIT` chars is returned unchanged;
     input of `SLACK_TEXT_LIMIT + 1` is truncated.
   - `updatePlaceholder` with an over-limit `text` records an `update` whose `text` is
     `=== SLACK_TEXT_LIMIT` chars (i.e. the helper is actually wired in, not just
     defined) and **does not throw**.
   - `postPlaceholder` still records the `_thinking…_` text verbatim (identity branch
     leaves it untouched) — keep/extend the existing assertion so the no-op is proven.

## Hard constraints (do NOT violate)

- The gate (`npm run gate`) must pass; paste the **real** tail of its output when done.
- Conventions per root `CLAUDE.md`: **no `any`, no `@ts-ignore`**; `NodeNext` ESM
  (`.js` import specifiers); `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` are on.
- **`@slack/bolt` only in `src/index.ts`** — `responder.ts` must stay Bolt-free
  (it already is; keep it that way). The gateway never imports the Agent SDK / runner.
- **Do not touch `protocol.ts`** (either copy) — this slice is gateway-only, no
  protocol change.
- **Do not touch `src/sessions/manager.ts`** — the whole point is that the fix lives
  at the responder seam so the call sites need no change. (If you believe a manager
  edit is unavoidable, STOP and say why in your report rather than editing it.)
- Never log message contents or tokens (you add no logging here anyway).
- Add no dependencies.
- **Do NOT commit** — leave the working tree for review. Do NOT edit this spec file.

## Out of scope (do NOT build)

- Chunking a long reply into multiple follow-up Slack messages (truncate-inline is
  the decided behavior; the agent's full output is already forwarded as a file by the
  separate `uploadFile` path).
- The structured `runner_error` sub-class (that's a separate issue, `8ebf72`).
- Bounding the fixed short gateway strings in `manager.ts` (cap notices, approval
  notices) — they're provably under the limit.
- Any Unicode/surrogate-pair-aware length counting — `.length`/`.slice` (UTF-16 code
  units) is the intended, simple guard here; matching Slack's exact grapheme count is
  not required for a safety bound.

## When done — report precisely (with REAL command output)

- What changed, file by file (one line each).
- The tail of `npm run gate` output (real, not paraphrased) — including the vitest
  pass count and the boundaries result.
- Any deviation from this spec and why.
- Anything a unit test can't catch that you verified another way (or couldn't).
