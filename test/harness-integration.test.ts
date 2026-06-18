/**
 * Integration test: drives the real gateway wiring end-to-end using
 * FakeSlackApp + CapturingSlackClient + FakeRunnerFactory — offline, no Slack,
 * no Docker, no network.
 *
 * Drain pattern mirrors test/manager.test.ts: fire event, wait 20 ms for the
 * async drain, then assert on CapturingSlackClient arrays.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildGateway } from '../src/app.js';
import { FakeSlackApp, CapturingSlackClient } from '../src/harness/fake-slack.js';
import { FakeRunnerFactory } from '../src/runner/fake.js';
import { NoopSessionStore } from '../src/sessions/store.js';

function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

function makeGateway() {
  const fakeApp = new FakeSlackApp();
  const slack = new CapturingSlackClient({ echo: false });
  const factory = new FakeRunnerFactory();
  const store = new NoopSessionStore();

  const { sessions } = buildGateway({
    app: fakeApp,
    slack,
    factory,
    store,
    idleTimeoutMs: 60_000,
    botUserId: 'UHARNESS',
  });

  return { fakeApp, slack, factory, sessions };
}

describe('harness-integration — mention → answer', () => {
  let fakeApp: FakeSlackApp;
  let slack: CapturingSlackClient;

  beforeEach(() => {
    ({ fakeApp, slack } = makeGateway());
  });

  it('posts a thinking placeholder and updates with Echo reply', async () => {
    await fakeApp.fireMention({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: '<@UHARNESS> hello world',
      ts: 'T1',
    });
    await drain();

    // Placeholder was posted
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toBe('_thinking…_');

    // At least one update; the last one must contain the echo
    expect(slack.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toBe('Echo: hello world');
  });
});

describe('harness-integration — thread reply routes to same session', () => {
  it('second message (fireReply) lands in the same session and produces another Echo', async () => {
    const { fakeApp, slack } = makeGateway();

    // First: mention
    await fakeApp.fireMention({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: '<@UHARNESS> first',
      ts: 'T1',
    });
    await drain();

    const postsAfterMention = slack.posts.length;
    const updatesAfterMention = slack.updates.length;

    // Second: reply in same thread
    await fakeApp.fireReply({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: 'second',
      ts: 'T2',
    });
    await drain();

    // A new placeholder was posted for the second turn
    expect(slack.posts.length).toBeGreaterThan(postsAfterMention);
    // More updates accumulated
    expect(slack.updates.length).toBeGreaterThan(updatesAfterMention);

    // The last update should echo the second message
    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toBe('Echo: second');
  });
});

describe('harness-integration — reply with no session is ignored', () => {
  it('fireReply for an unknown thread produces no posts or updates', async () => {
    const { fakeApp, slack } = makeGateway();

    await fakeApp.fireReply({
      team: 'T1',
      channel: 'C',
      threadTs: 'UNKNOWN-THREAD',
      user: 'U1',
      text: 'nobody home',
      ts: 'T3',
    });
    await drain();

    expect(slack.posts).toHaveLength(0);
    expect(slack.updates).toHaveLength(0);
  });
});
