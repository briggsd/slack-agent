import { describe, it, expect, beforeEach } from 'vitest';
import { FakeSlackClient } from '../src/slack/fake-slack-client.js';
import { postPlaceholder, updatePlaceholder, boundSlackText, SLACK_TEXT_LIMIT } from '../src/slack/responder.js';

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

  it('postPlaceholder still posts "_thinking…_" verbatim (identity branch)', async () => {
    await postPlaceholder(slack, 'C9999', '555.666');
    expect(slack.posts[0]?.text).toBe('_thinking…_');
  });
});

describe('boundSlackText', () => {
  it('returns short text unchanged (identity)', () => {
    const text = 'Hello, world!';
    expect(boundSlackText(text)).toBe(text);
  });

  it('returns empty string unchanged', () => {
    expect(boundSlackText('')).toBe('');
  });

  it('truncates text longer than SLACK_TEXT_LIMIT to exactly SLACK_TEXT_LIMIT chars', () => {
    const longText = 'a'.repeat(SLACK_TEXT_LIMIT + 100);
    const result = boundSlackText(longText);
    expect(result.length).toBe(SLACK_TEXT_LIMIT);
    expect(result.endsWith('\n\n…[truncated]')).toBe(true);
    // The first 100 chars of the original survive
    expect(result.slice(0, 100)).toBe('a'.repeat(100));
  });

  it('returns text of exactly SLACK_TEXT_LIMIT chars unchanged', () => {
    const text = 'b'.repeat(SLACK_TEXT_LIMIT);
    expect(boundSlackText(text)).toBe(text);
  });

  it('truncates text of SLACK_TEXT_LIMIT + 1 chars', () => {
    const text = 'c'.repeat(SLACK_TEXT_LIMIT + 1);
    const result = boundSlackText(text);
    expect(result.length).toBe(SLACK_TEXT_LIMIT);
    expect(result.endsWith('\n\n…[truncated]')).toBe(true);
  });
});

describe('updatePlaceholder with over-limit text', () => {
  it('records an update whose text is exactly SLACK_TEXT_LIMIT chars and does not throw', async () => {
    const slack = new FakeSlackClient();
    const placeholder = { channel: 'C0001', ts: '100.000' };
    const longText = 'x'.repeat(SLACK_TEXT_LIMIT + 500);
    await expect(updatePlaceholder(slack, placeholder, longText)).resolves.toBeUndefined();
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.text.length).toBe(SLACK_TEXT_LIMIT);
  });
});
