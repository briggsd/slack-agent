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

/** Slack's maximum text field length (UTF-16 code units). */
export const SLACK_TEXT_LIMIT = 40000;

const MARKER = '\n\n…[truncated]';

/**
 * Bound text to Slack's 40k-char limit.
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
