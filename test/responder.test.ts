import { describe, it, expect, beforeEach } from 'vitest';
import type { SlackClientLike } from '../src/slack/responder.js';
import { postPlaceholder, updatePlaceholder } from '../src/slack/responder.js';

/** Fake Slack client that records all calls */
export class FakeSlackClient implements SlackClientLike {
  public posts: Array<{ channel: string; thread_ts: string; text: string }> = [];
  public updates: Array<{ channel: string; ts: string; text: string }> = [];
  private nextTs = 1;

  async postMessage(params: {
    channel: string;
    thread_ts: string;
    text: string;
  }): Promise<{ ts: string }> {
    this.posts.push({ ...params });
    return { ts: String(this.nextTs++) };
  }

  async update(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<void> {
    this.updates.push({ ...params });
  }
}

describe('responder', () => {
  let slack: FakeSlackClient;

  beforeEach(() => {
    slack = new FakeSlackClient();
  });

  it('postPlaceholder posts "thinking…" and returns the ts', async () => {
    const placeholder = await postPlaceholder(slack, 'C1234', '111.222');
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({
      channel: 'C1234',
      thread_ts: '111.222',
      text: '_thinking…_',
    });
    expect(placeholder).toEqual({ channel: 'C1234', ts: '1' });
  });

  it('updatePlaceholder calls update with the right params', async () => {
    const placeholder = { channel: 'C1234', ts: '999.000' };
    await updatePlaceholder(slack, placeholder, 'Hello world');
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toEqual({
      channel: 'C1234',
      ts: '999.000',
      text: 'Hello world',
    });
  });

  it('multiple updates accumulate in order', async () => {
    const placeholder = { channel: 'C5678', ts: '1.0' };
    await updatePlaceholder(slack, placeholder, 'step 1');
    await updatePlaceholder(slack, placeholder, 'step 2');
    await updatePlaceholder(slack, placeholder, 'done');
    expect(slack.updates.map((u) => u.text)).toEqual(['step 1', 'step 2', 'done']);
  });
});
