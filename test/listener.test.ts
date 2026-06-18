import { describe, it, expect, beforeEach } from 'vitest';
import { handleMention, handleMessage } from '../src/slack/listener.js';
import type { HandlerDeps, MentionEventBody, MessageEventBody } from '../src/slack/listener.js';
import { FakeRunnerFactory } from '../src/runner/fake.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { QueueItem } from '../src/sessions/manager.js';
import { FakeSlackClient } from './responder.test.js';

function makeDeps(idleTimeoutMs = 60_000): {
  deps: HandlerDeps;
  factory: FakeRunnerFactory;
  slack: FakeSlackClient;
} {
  const slack = new FakeSlackClient();
  const factory = new FakeRunnerFactory();
  const sessions = new SessionManager({ idleTimeoutMs, factory, slack });
  return { deps: { sessions, slack, botUserId: 'U_BOT' }, factory, slack };
}

function mentionBody(
  overrides: Partial<MentionEventBody['event']> = {},
  topLevel: Partial<Omit<MentionEventBody, 'event'>> = {},
): MentionEventBody {
  return {
    event: {
      type: 'app_mention',
      user: 'U_USER',
      text: '<@U_BOT> hello there',
      ts: '100.000',
      channel: 'C_CHAN',
      ...overrides,
    },
    ...topLevel,
  };
}

function messageBody(
  overrides: Partial<MessageEventBody['event']> = {},
  topLevel: Partial<Omit<MessageEventBody, 'event'>> = {},
): MessageEventBody {
  return {
    event: {
      type: 'message',
      user: 'U_USER',
      text: 'a reply',
      ts: '101.000',
      channel: 'C_CHAN',
      thread_ts: '100.000',
      ...overrides,
    },
    ...topLevel,
  };
}

describe('handleMention', () => {
  let deps: HandlerDeps;
  let factory: FakeRunnerFactory;
  let slack: FakeSlackClient;

  beforeEach(() => {
    ({ deps, factory, slack } = makeDeps());
  });

  it('creates a session and strips the bot mention', async () => {
    await handleMention(mentionBody(), deps);
    // Wait for async queue drain
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.creates).toHaveLength(1);
    expect(factory.creates[0]).toBe('unknown:C_CHAN:100.000');
    // The runner should have received the stripped message
    const runner = factory.runners[0];
    expect(runner).toBeDefined();
    expect(runner?.sends[0]).toBe('hello there');
  });

  it('uses thread_ts as session key when present', async () => {
    await handleMention(
      mentionBody({ thread_ts: '99.000', ts: '100.000' }),
      deps,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.creates[0]).toBe('unknown:C_CHAN:99.000');
  });

  it('ignores bot messages', async () => {
    await handleMention(mentionBody({ bot_id: 'B123' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.creates).toHaveLength(0);
  });

  it('ignores edited subtypes', async () => {
    await handleMention(mentionBody({ subtype: 'message_changed' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.creates).toHaveLength(0);
  });

  it('posts a placeholder reply', async () => {
    await handleMention(mentionBody(), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(slack.posts.length).toBeGreaterThanOrEqual(1);
    expect(slack.posts[0]?.text).toBe('_thinking…_');
  });

  it('reuses existing session on second mention in same thread', async () => {
    await handleMention(mentionBody({ ts: '100.000' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    await handleMention(mentionBody({ ts: '100.001', thread_ts: '100.000' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    // Only one factory.create call — session was reused
    expect(factory.creates).toHaveLength(1);
  });
});

describe('handleMessage (thread replies)', () => {
  let deps: HandlerDeps;
  let factory: FakeRunnerFactory;

  beforeEach(() => {
    ({ deps, factory } = makeDeps());
  });

  it('ignores thread replies when no session exists', async () => {
    const routed = await (async () => {
      await handleMessage(messageBody(), deps);
      return factory.creates.length;
    })();
    expect(routed).toBe(0);
    expect(factory.creates).toHaveLength(0);
  });

  it('routes to existing session', async () => {
    // First create session via mention
    await handleMention(mentionBody(), deps);
    await new Promise((r) => setTimeout(r, 10));
    // Then send a thread reply
    await handleMessage(messageBody({ text: 'follow-up' }), deps);
    await new Promise((r) => setTimeout(r, 20));
    const runner = factory.runners[0];
    expect(runner?.sends).toContain('follow-up');
  });

  it('ignores bot thread replies', async () => {
    await handleMention(mentionBody(), deps);
    await new Promise((r) => setTimeout(r, 10));
    const sendsBefore = factory.runners[0]?.sends.length ?? 0;
    await handleMessage(messageBody({ bot_id: 'B999' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runners[0]?.sends.length).toBe(sendsBefore);
  });

  it('ignores message_changed subtype', async () => {
    await handleMention(mentionBody(), deps);
    await new Promise((r) => setTimeout(r, 10));
    const sendsBefore = factory.runners[0]?.sends.length ?? 0;
    await handleMessage(messageBody({ subtype: 'message_changed' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runners[0]?.sends.length).toBe(sendsBefore);
  });

  it('ignores thread replies that mention the bot (app_mention owns those)', async () => {
    // A reply that @mentions the bot fires BOTH app_mention and message events;
    // handleMessage must skip it or the message is processed twice.
    await handleMention(mentionBody(), deps);
    await new Promise((r) => setTimeout(r, 10));
    const sendsBefore = factory.runners[0]?.sends.length ?? 0;
    await handleMessage(messageBody({ text: '<@U_BOT> follow-up' }), deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.runners[0]?.sends.length).toBe(sendsBefore);
  });

  it('ignores messages without thread_ts (top-level non-mention messages)', async () => {
    const body = messageBody();
    // Remove thread_ts to simulate a top-level message
    const bodyNoThread: MessageEventBody = {
      event: { ...body.event, thread_ts: undefined },
    };
    await handleMessage(bodyNoThread, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.creates).toHaveLength(0);
  });
});

describe('handleMention + handleMessage — teamId/userId on QueueItem', () => {
  it('records team_id from envelope and user from event on enqueueNew (mention)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const sessions = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    const capturedItems: QueueItem[] = [];
    const original = sessions.enqueueNew.bind(sessions);
    sessions.enqueueNew = async (key: string, item: QueueItem): Promise<void> => {
      capturedItems.push(item);
      return original(key, item);
    };

    const deps: HandlerDeps = { sessions, slack, botUserId: 'U_BOT' };

    await handleMention(
      mentionBody({}, { team_id: 'T_TEAM' }),
      deps,
    );

    expect(capturedItems).toHaveLength(1);
    expect(capturedItems[0]?.teamId).toBe('T_TEAM');
    expect(capturedItems[0]?.userId).toBe('U_USER');
  });

  it('falls back team_id to undefined when envelope has no team_id', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const sessions = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });

    const capturedItems: QueueItem[] = [];
    const original = sessions.enqueueNew.bind(sessions);
    sessions.enqueueNew = async (key: string, item: QueueItem): Promise<void> => {
      capturedItems.push(item);
      return original(key, item);
    };

    const deps: HandlerDeps = { sessions, slack, botUserId: 'U_BOT' };

    await handleMention(mentionBody(), deps);

    expect(capturedItems).toHaveLength(1);
    expect(capturedItems[0]?.teamId).toBeUndefined();
    expect(capturedItems[0]?.userId).toBe('U_USER');
  });

  it('records team_id from envelope and user from event on enqueueExisting (message)', async () => {
    const slack = new FakeSlackClient();
    const factory = new FakeRunnerFactory();
    const sessions = new SessionManager({ idleTimeoutMs: 60_000, factory, slack });
    const deps: HandlerDeps = { sessions, slack, botUserId: 'U_BOT' };

    // Create the session first via a mention
    await handleMention(mentionBody({}, { team_id: 'T_TEAM' }), deps);
    await new Promise((r) => setTimeout(r, 10));

    const capturedItems: QueueItem[] = [];
    const original = sessions.enqueueExisting.bind(sessions);
    sessions.enqueueExisting = (key: string, item: QueueItem): boolean => {
      capturedItems.push(item);
      return original(key, item);
    };

    await handleMessage(
      messageBody({ user: 'U_OTHER' }, { team_id: 'T_TEAM' }),
      deps,
    );

    expect(capturedItems).toHaveLength(1);
    expect(capturedItems[0]?.teamId).toBe('T_TEAM');
    expect(capturedItems[0]?.userId).toBe('U_OTHER');
  });
});
