# Task: Deliver long agent replies via a file instead of dropping them (c05e5b)

You are implementing one slice in `/Users/jedanner/workspace/slack-agent` (this is a
worktree of it; TypeScript, Node 20+, ESM, vitest, strict tsc). **Read the root
`CLAUDE.md` first**, then the context below. You are on branch
`sonnet/slack-long-reply-file-forward`.

## Why (context — read before writing code)

When the agent's text reply exceeds Slack's message-length limit, it currently gets
truncated to `SLACK_TEXT_LIMIT` (39000) — and even that truncated post was observed
to still hit Slack's `msg_too_long` (PR #412e0d/#90 added a graceful "too long to post
in Slack" backstop, but it **drops the content**). Live, this blocked a real
build-spec approval flow: the agent's SPEC/analysis replies were too long, so the user
got `:x: too long` and never saw the content to act on.

Fix: when the reply is long, **post a short preview and upload the full text as a
file** (the existing `uploadFile` path already does this for agent-produced files), so
the content is always delivered. This keeps normal-size replies inline and unchanged.

### Grounded facts (verified at current `main`)

- The agent's text reply is posted in `src/sessions/manager.ts`'s `driveToThread`, the
  `event.type === 'text'` branch (`:821-826`):
  - build-spec pending → `tryUpdate(formatBuildSpecApprovalPrompt(session.pendingApproval.prompt, event.text))` (`:823`)
  - otherwise → `tryUpdate(event.text)` (`:825`)
- `tryUpdate` (`:787-791`) calls `updatePlaceholder(this.slack, placeholder, text)` when
  `placeholder !== null`; `updatePlaceholder` (`responder.ts:60-71`) applies
  `boundSlackText` (truncates at `SLACK_TEXT_LIMIT = 39000`).
- The file-upload path already exists: the `event.type === 'file'` branch (`:805-820`)
  calls `this.slack.uploadFile({ channel: item.channel, thread_ts: item.threadTs,
  filename, data })` inside a try/catch that logs + posts a `:x:` notice on failure.
  `SlackClientLike.uploadFile` takes `{ channel, thread_ts, filename, data: Buffer }`.
- `item.channel` / `item.threadTs` are in scope in `driveToThread` (used at `:808-809`).
- `gatewayErrorMeta(err)` (`manager.ts`, exported) builds a safe, content-free error
  string — use it for the upload-failure log (do NOT log the message body).
- The test fake `FakeSlackClient` (`src/slack/fake-slack-client.ts`) records `updates`
  and `uploads` (and has an `uploadError` hook) — use it in tests.

## CRITICAL — do not stop after exploration

Make the edits, add tests, run `npm run gate`, fix failures, then stop.

## Implementation

### 1. A safe inline threshold + preview length (in `responder.ts`)

`SLACK_TEXT_LIMIT = 39000` was observed to still hit `msg_too_long` on a giant reply,
so the inline path needs a comfortable margin under Slack's edge. Add to
`src/slack/responder.ts`:

```ts
/** Replies up to this length post inline; longer ones are uploaded as a file
 *  (a comfortable margin under Slack's ~40k message limit, which rejects at the edge). */
export const SLACK_INLINE_LIMIT = 30000;
```

### 2. A `tryUpdate`-shaped helper that file-forwards when long (`driveToThread`)

In `driveToThread`, alongside `tryUpdate`, add a helper (closure capturing `this.slack`,
`placeholder`, `item`, `session`), e.g.:

```ts
// Post `text`; if it exceeds the inline limit, post a short preview and upload the
// full text as a file so the content is never dropped. No-op when no placeholder.
const tryUpdateOrFile = async (text: string, filename: string): Promise<void> => {
  if (placeholder === null) return;
  if (text.length <= SLACK_INLINE_LIMIT) {
    await updatePlaceholder(this.slack, placeholder, text);
    return;
  }
  const preview = text.slice(0, PREVIEW_LEN);
  await updatePlaceholder(
    this.slack,
    placeholder,
    `${preview}\n\n_…reply too long for Slack — full text attached as ${filename}._`,
  );
  try {
    await this.slack.uploadFile({
      channel: item.channel,
      thread_ts: item.threadTs,
      filename,
      data: Buffer.from(text, 'utf-8'),
    });
  } catch (uploadErr: unknown) {
    console.error(`[session] reply file upload failed in ${session.key}: ${gatewayErrorMeta(uploadErr)}`);
    // The preview is already posted; nothing more to do.
  }
};
```

- `PREVIEW_LEN`: a small, definitely-safe constant (e.g. `2000`) — define it (in
  `responder.ts` next to `SLACK_INLINE_LIMIT`, exported, or as a local const). The
  preview + the short note must be well under `SLACK_INLINE_LIMIT`.
- The preview goes through `updatePlaceholder` → `boundSlackText`, so it's also bounded
  defensively — but at ~2000 chars it never approaches the limit.

### 3. Use it for the agent text reply (both branches at `:821-826`)

Replace the two `tryUpdate(<text>)` calls in the `event.type === 'text'` branch with
`tryUpdateOrFile(<same text>, 'response.md')`:
- build-spec branch (`:823`):
  `await tryUpdateOrFile(formatBuildSpecApprovalPrompt(session.pendingApproval.prompt, event.text), 'response.md');`
- plain branch (`:825`):
  `await tryUpdateOrFile(event.text, 'response.md');`

Leave the `status` branch (`:799-804`), the `file` branch, the `approval_requested`
post (`:845`), and all other `tryUpdate(...)` calls UNCHANGED — those are short/fixed
or already handled. Scope this slice to the agent's text reply only.

## Acceptance criteria

1. `npm run gate` passes — `npm run check` (tsc + runner type-check + vitest) **and**
   `npm run boundaries`.
2. `SLACK_INLINE_LIMIT` exported from `responder.ts` (= 30000); a `PREVIEW_LEN` constant
   exists.
3. A text reply **≤ `SLACK_INLINE_LIMIT`** posts inline via `updatePlaceholder` with the
   full text and **does NOT** upload a file. (Test asserts `FakeSlackClient.updates`
   has the full text; `uploads` is empty.)
4. A text reply **> `SLACK_INLINE_LIMIT`** posts a preview ending in the
   "full text attached as response.md" note, AND uploads the full text as `response.md`
   (Test asserts: the update text length is ≤ a safe bound and contains the note; one
   upload with `filename === 'response.md'` and `data` decoding to the FULL original
   text). Cover both the plain and the build-spec-wrapped branch (the latter via a
   pending build_spec approval + a long wrapped prompt).
5. If `uploadFile` rejects (`FakeSlackClient.uploadError`), the preview is still posted
   and the turn does not throw (the drain catch is not hit). Test it.

## Hard constraints (do NOT violate)

- Gate (`npm run gate`) must pass; paste the tail.
- Never log/audit the reply body — the upload-failure log uses `gatewayErrorMeta`
  (content-free) only. (The reply text itself goes to Slack — the user's own thread —
  inline and/or as the file; that is allowed.)
- No `any`, no `@ts-ignore`; NodeNext ESM. Suite stays offline (use `FakeSlackClient`).
- Don't change `boundSlackText` / `SLACK_TEXT_LIMIT`, the runner, or `protocol.ts`.
  Don't touch the `status`/`file`/`approval_requested` post paths.
- Don't add dependencies. Don't commit. Don't edit this spec file.

## Out of scope (do NOT build)

- Splitting a long reply across multiple Slack messages (a file is simpler + lossless).
- Pinning Slack's exact `chat.update` limit / changing the #90 graceful backstop (it
  stays as the safety net for any residual path).
- File-forwarding status updates or the standalone approval-prompt post.

## When done — report precisely (with REAL command output)

- File-by-file summary (one line each).
- The tail of `npm run gate` — test count + file count.
- Confirmation: a long reply now uploads the full text as `response.md` + a preview;
  short replies are unchanged; upload failure degrades to the preview without throwing.
- Any deviation from this spec and why.
