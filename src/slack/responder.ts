/**
 * Minimal Slack client interface — injected so no module except index.ts imports Bolt.
 */
export interface SlackClientLike {
  postMessage(params: {
    channel: string;
    thread_ts: string;
    text: string;
  }): Promise<{ ts: string }>;

  update(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<void>;

  uploadFile(params: {
    channel: string;
    thread_ts: string;
    filename: string;
    data: Buffer;
  }): Promise<void>;
}

export interface Placeholder {
  channel: string;
  ts: string;
}

/** Cap for Slack text fields — kept safely below Slack's 40,000-char limit (which rejects with `msg_too_long`). */
export const SLACK_TEXT_LIMIT = 39000;

/** Replies up to this length post inline; longer ones are uploaded as a file
 *  (a comfortable margin under Slack's ~40k message limit, which rejects at the edge). */
export const SLACK_INLINE_LIMIT = 30000;

/** Number of characters shown as a preview before the "full text attached" note. */
export const PREVIEW_LEN = 2000;

const MARKER = '\n\n…[truncated]';

/**
 * Bound text safely below Slack's 40k-char limit.
 * Returns text unchanged when within the limit; truncates with a fixed marker otherwise.
 */
export function boundSlackText(text: string): string {
  if (text.length <= SLACK_TEXT_LIMIT) {
    return text;
  }
  return text.slice(0, SLACK_TEXT_LIMIT - MARKER.length) + MARKER;
}

/** Post the initial "thinking…" placeholder in a thread and return its ts. */
export async function postPlaceholder(
  slack: SlackClientLike,
  channel: string,
  threadTs: string,
): Promise<Placeholder> {
  const result = await slack.postMessage({
    channel,
    thread_ts: threadTs,
    text: boundSlackText('_thinking…_'),
  });
  return { channel, ts: result.ts };
}

/** Update an existing placeholder message with new text. */
export async function updatePlaceholder(
  slack: SlackClientLike,
  placeholder: Placeholder,
  text: string,
): Promise<void> {
  await slack.update({
    channel: placeholder.channel,
    ts: placeholder.ts,
    text: boundSlackText(text),
  });
}
