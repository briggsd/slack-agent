/**
 * Unit tests for RealPublishService (src/oneshot/publish-service.ts).
 *
 * Uses FakeBroker and FakeGitNodeExecutor so no Docker or network is needed.
 */

import { describe, it, expect } from 'vitest';
import { FakeBroker } from '../src/broker/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import { RealPublishService } from '../src/oneshot/publish-service.js';

describe('RealPublishService', () => {
  it('rejects an invalid repo slug before leasing or pushing', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealPublishService(broker, gitNodes);

    for (const bad of ['../etc/passwd', '../repo', 'owner/..', './repo', 'owner/.', 'owner', 'owner/repo/extra', 'owner/re po', '']) {
      const outcome = await svc.publish({ repo: bad, volume: 'vol' });
      expect(outcome.ok).toBe(false);
    }

    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });

  it('happy path leases, pushes, opens a PR, and revokes', async () => {
    const broker = new FakeBroker('test-token');
    const gitNodes = new FakeGitNodeExecutor('https://github.com/owner/repo/pull/1');
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({
      repo: 'owner/repo',
      volume: 'slackbot-ws-session-1',
      title: 'Verified title',
      body: 'Verified body',
    });

    expect(outcome).toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/1' });
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]).toMatchObject({ host: 'github', repo: 'owner/repo' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.pushes[0]).toMatchObject({
      repo: 'owner/repo',
      branch: 'slackbot/oneshot-session-1',
      workdir: '/workspace/owner-repo',
      volume: 'slackbot-ws-session-1',
    });
    expect(gitNodes.changeRequests).toHaveLength(1);
    expect(gitNodes.changeRequests[0]).toMatchObject({
      repo: 'owner/repo',
      head: 'slackbot/oneshot-session-1',
      base: 'main',
      title: 'Verified title',
      body: 'Verified body',
    });
  });

  it('uses conservative title/body fallbacks when optional text is empty', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor('https://example.test/pr/fallback');
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({
      repo: 'my-org/my-repo',
      volume: 'plain-volume',
      title: '   ',
      body: '',
    });

    expect(outcome.ok).toBe(true);
    expect(gitNodes.pushes[0]).toMatchObject({
      repo: 'my-org/my-repo',
      branch: 'slackbot/oneshot-plain-volume',
      workdir: '/workspace/my-org-my-repo',
      volume: 'plain-volume',
    });
    expect(gitNodes.changeRequests[0]?.title).toBe('Publish verified changes');
    expect(gitNodes.changeRequests[0]?.body).toContain('Automated one-shot implementation.');
  });

  it('push failure returns ok:false and revokes without opening a PR', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextPush(new Error('https://x-access-token:secret@example.test/owner/repo push failed'));
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, reason: 'git push failed' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });

  it('open PR failure returns ok:false and revokes after push', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextOpenChange(new Error('https://x-access-token:secret@example.test/owner/repo open failed'));
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, reason: 'open PR failed' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.pushes).toHaveLength(1);
    expect(gitNodes.changeRequests).toHaveLength(1);
  });

  it('broker failure returns ok:false and does not push', async () => {
    const broker = new FakeBroker();
    broker.lease = async () => { throw new Error('secret broker detail'); };
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, reason: 'credential lease failed' });
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});
