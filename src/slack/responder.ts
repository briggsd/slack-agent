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
}

export interface Placeholder {
  channel: string;
  ts: string;
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
    text: '_thinking…_',
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
    text,
  });
}
