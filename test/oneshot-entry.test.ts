/**
 * End-to-end integration test for the one-shot repo entry path.
 *
 * Fires a `task` mention through a real gateway wired with DispatchingRunnerFactory
 * over fake dependencies — offline, no Slack, no Docker, no network.
 *
 * Mirrors test/harness-integration.test.ts in structure.
 */
import { describe, it, expect } from 'vitest';
import { buildGateway } from '../src/app.js';
import { FakeSlackApp, CapturingSlackClient } from '../src/harness/fake-slack.js';
import { FakeRunnerFactory } from '../src/runner/fake.js';
import { NoopSessionStore } from '../src/sessions/store.js';
import { DispatchingRunnerFactory } from '../src/oneshot/dispatching-factory.js';
import { FakeBroker } from '../src/broker/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';

const FAKE_PR_URL = 'https://github.test/acme/widgets/pull/42';

function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

function makeGateway() {
  const fakeApp = new FakeSlackApp();
  const slack = new CapturingSlackClient({ echo: false });
  const store = new NoopSessionStore();

  const innerFactory = new FakeRunnerFactory();
  const fakeBroker = new FakeBroker();
  const fakeGitNodes = new FakeGitNodeExecutor(FAKE_PR_URL);
  const factory = new DispatchingRunnerFactory(innerFactory, fakeBroker, fakeGitNodes);

  const { sessions } = buildGateway({
    app: fakeApp,
    slack,
    factory,
    store,
    idleTimeoutMs: 60_000,
    botUserId: 'UHARNESS',
  });

  return { fakeApp, slack, fakeBroker, fakeGitNodes, innerFactory, sessions };
}

describe('oneshot-entry — task mention triggers one-shot path', () => {
  it('posts a placeholder then updates with Opened PR text', async () => {
    const { fakeApp, slack } = makeGateway();

    await fakeApp.fireMention({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: '<@UHARNESS> task github:acme/widgets do the thing',
      ts: 'T1',
    });
    await drain();

    // A placeholder must have been posted
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toBe('_thinking…_');

    // The last update must contain the PR url
    expect(slack.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toContain(`Opened PR: ${FAKE_PR_URL}`);
  });

  it('FakeBroker records exactly one lease with host=github and repo=acme/widgets', async () => {
    const { fakeApp, fakeBroker } = makeGateway();

    await fakeApp.fireMention({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: '<@UHARNESS> task github:acme/widgets do the thing',
      ts: 'T1',
    });
    await drain();

    expect(fakeBroker.leases).toHaveLength(1);
    expect(fakeBroker.leases[0]?.host).toBe('github');
    expect(fakeBroker.leases[0]?.repo).toBe('acme/widgets');
  });

  it('FakeGitNodeExecutor records a clone, a push, and an openChangeRequest', async () => {
    const { fakeApp, fakeGitNodes } = makeGateway();

    await fakeApp.fireMention({
      team: 'T1',
      channel: 'C',
      threadTs: 'T1',
      user: 'U1',
      text: '<@UHARNESS> task github:acme/widgets do the thing',
      ts: 'T1',
    });
    await drain();

    expect(fakeGitNodes.clones).toHaveLength(1);
    expect(fakeGitNodes.pushes).toHaveLength(1);
    expect(fakeGitNodes.changeRequests).toHaveLength(1);
  });

  it('conversational mention through same dispatching gateway still echoes and records no lease', async () => {
    const { fakeApp, slack, fakeBroker } = makeGateway();

    await fakeApp.fireMention({
      team: 'T2',
      channel: 'C',
      threadTs: 'T2',
      user: 'U1',
      text: '<@UHARNESS> hello',
      ts: 'T2',
    });
    await drain();

    // Should get the normal Echo response
    expect(slack.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slack.updates[slack.updates.length - 1];
    expect(lastUpdate?.text).toBe('Echo: hello');

    // No broker lease should have been called
    expect(fakeBroker.leases).toHaveLength(0);
  });
});
