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
    expect(gitNodes.repoVerifications).toHaveLength(0);
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

    expect(outcome).toEqual({
      ok: true,
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      headSha: 'fake-head-sha',
    });
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]).toMatchObject({ host: 'github', repo: 'owner/repo' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.repoVerifications).toEqual([{
      repo: 'owner/repo',
      workdir: '/workspace/owner-repo',
      volume: 'slackbot-ws-session-1',
    }]);
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

  it('repo binding mismatch returns ok:false before leasing or pushing', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setVerifyRepoResult(false);
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.publish({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, reason: 'repo binding mismatch' });
    expect(gitNodes.repoVerifications).toEqual([{
      repo: 'owner/repo',
      workdir: '/workspace/owner-repo',
      volume: 'vol',
    }]);
    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
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

  it('editPr happy path leases, edits this thread PR, and revokes', async () => {
    const broker = new FakeBroker('test-token');
    const gitNodes = new FakeGitNodeExecutor('https://github.com/owner/repo/pull/2');
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.editPr({
      repo: 'owner/repo',
      volume: 'slackbot-ws-session-2',
      title: 'Updated title',
      body: 'Updated body',
    });

    expect(outcome).toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/2' });
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]).toMatchObject({ host: 'github', repo: 'owner/repo' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.prEdits).toEqual([{
      lease: expect.objectContaining({ token: 'test-token', host: 'github', repo: 'owner/repo' }),
      repo: 'owner/repo',
      head: 'slackbot/oneshot-session-2',
      title: 'Updated title',
      body: 'Updated body',
    }]);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.repoVerifications).toHaveLength(0);
  });

  it('editPr maps notFound to no open PR for this thread', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setEditChangeResult({ notFound: true });
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.editPr({ repo: 'owner/repo', volume: 'vol', title: 'T' });

    expect(outcome).toEqual({ ok: false, reason: 'no open PR for this thread' });
    expect(broker.revokes).toHaveLength(1);
  });

  it('editPr with neither title nor body refuses before leasing (no no-op PATCH)', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealPublishService(broker, gitNodes);

    // Both empty/whitespace → both normalize to undefined → nothing to change.
    const outcome = await svc.editPr({ repo: 'owner/repo', volume: 'vol', title: ' ', body: '' });

    expect(outcome).toEqual({ ok: false, reason: 'nothing to edit (provide a title or body)' });
    expect(broker.leases).toHaveLength(0); // refused before any credential lease
    expect(gitNodes.prEdits).toHaveLength(0); // no GitHub round-trip
  });

  it('editPr normalizes an empty sibling field but keeps the provided one', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.editPr({ repo: 'owner/repo', volume: 'vol', title: 'Updated', body: ' ' });

    expect(outcome).toEqual({ ok: true, prUrl: 'https://example.test/pr/1' });
    expect(gitNodes.prEdits[0]).toEqual({
      lease: expect.objectContaining({ host: 'github', repo: 'owner/repo' }),
      repo: 'owner/repo',
      head: 'slackbot/oneshot-vol',
      title: 'Updated', // empty body dropped; provided title preserved
    });
  });

  it('commentPr happy path leases, comments on this thread PR, and revokes', async () => {
    const broker = new FakeBroker('comment-token');
    const gitNodes = new FakeGitNodeExecutor('https://github.com/owner/repo/pull/3');
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.commentPr({
      repo: 'owner/repo',
      volume: 'slackbot-ws-session-3',
      comment: 'Status update',
    });

    expect(outcome).toEqual({ ok: true, prUrl: 'https://github.com/owner/repo/pull/3' });
    expect(broker.leases).toHaveLength(1);
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.prComments).toEqual([{
      lease: expect.objectContaining({ token: 'comment-token', host: 'github', repo: 'owner/repo' }),
      repo: 'owner/repo',
      head: 'slackbot/oneshot-session-3',
      comment: 'Status update',
    }]);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.repoVerifications).toHaveLength(0);
  });

  it('commentPr with an empty/whitespace comment refuses before leasing', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.commentPr({ repo: 'owner/repo', volume: 'vol', comment: '   ' });

    expect(outcome).toEqual({ ok: false, reason: 'nothing to comment (provide a comment)' });
    expect(broker.leases).toHaveLength(0); // refused before any credential lease
    expect(gitNodes.prComments).toHaveLength(0); // no GitHub round-trip
  });

  it('commentPr maps notFound to no open PR for this thread', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setCommentChangeResult({ notFound: true });
    const svc = new RealPublishService(broker, gitNodes);

    const outcome = await svc.commentPr({ repo: 'owner/repo', volume: 'vol', comment: 'Hello' });

    expect(outcome).toEqual({ ok: false, reason: 'no open PR for this thread' });
    expect(broker.revokes).toHaveLength(1);
  });
});
