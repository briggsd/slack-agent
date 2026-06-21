/**
 * Unit tests for RealCloneService (src/oneshot/clone-service.ts).
 *
 * Uses FakeBroker and FakeGitNodeExecutor so no Docker or network is needed.
 */

import { describe, it, expect } from 'vitest';
import { RealCloneService } from '../src/oneshot/clone-service.js';
import { FakeBroker } from '../src/broker/fake.js';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';

function makeService(
  broker: FakeBroker,
  gitNodes: FakeGitNodeExecutor,
  allowedRepos: readonly string[] = ['owner/repo', 'my-org/my-repo'],
): RealCloneService {
  return new RealCloneService(broker, gitNodes, {
    allowedRepos: new Set(allowedRepos.map((repo) => repo.toLowerCase())),
  });
}

describe('RealCloneService', () => {
  it('leases github credential, clones with workdir+volume+shallow:true, revokes', async () => {
    const broker = new FakeBroker('test-token');
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes);

    const outcome = await svc.clone({ repo: 'owner/repo', volume: 'slackbot-ws-test' });

    expect(outcome).toEqual({ ok: true, workdir: '/workspace/owner-repo' });
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]).toMatchObject({ host: 'github', repo: 'owner/repo' });
    expect(broker.revokes).toHaveLength(1);
    expect(gitNodes.clones).toHaveLength(1);
    expect(gitNodes.clones[0]).toMatchObject({
      repo: 'owner/repo',
      workdir: '/workspace/owner-repo',
      volume: 'slackbot-ws-test',
      shallow: true,
    });
  });

  it('derives workdir by replacing slashes with dashes', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes);

    const outcome = await svc.clone({ repo: 'my-org/my-repo', volume: 'some-vol' });

    expect(outcome).toEqual({ ok: true, workdir: '/workspace/my-org-my-repo' });
  });

  it('on clone failure: returns ok:false+error and still revokes', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextClone(new Error('auth failed'));
    const svc = makeService(broker, gitNodes);

    const outcome = await svc.clone({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, error: 'auth failed' });
    expect(broker.revokes).toHaveLength(1); // lease was still revoked
  });

  it('rejects an invalid repo slug before leasing or cloning (defense-in-depth)', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes);

    for (const bad of ['../etc/passwd', 'owner', 'owner/repo/extra', 'owner/re po', '']) {
      const outcome = await svc.clone({ repo: bad, volume: 'vol' });
      expect(outcome.ok).toBe(false);
    }
    // No lease minted and no clone attempted for any rejected slug.
    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.clones).toHaveLength(0);
  });

  it('rejects a safe but unlisted repo before leasing or cloning', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes, ['owner/repo']);

    const outcome = await svc.clone({ repo: 'other/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, error: 'repo not allowed' });
    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.clones).toHaveLength(0);
  });

  it('an empty allowlist denies every model-chosen clone', async () => {
    const broker = new FakeBroker();
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes, []);

    const outcome = await svc.clone({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, error: 'repo not allowed' });
    expect(broker.leases).toHaveLength(0);
    expect(gitNodes.clones).toHaveLength(0);
  });

  it('on broker failure: returns ok:false+error, no clone called', async () => {
    const broker = new FakeBroker();
    broker.lease = async () => { throw new Error('no token'); };
    const gitNodes = new FakeGitNodeExecutor();
    const svc = makeService(broker, gitNodes);

    const outcome = await svc.clone({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, error: 'no token' });
    expect(gitNodes.clones).toHaveLength(0);
  });
});
