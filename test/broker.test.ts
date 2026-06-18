import { describe, it, expect } from 'vitest';
import { BotAccountBroker } from '../src/broker/bot-account.js';
import { FakeBroker } from '../src/broker/fake.js';
import type { LeaseRequest, GitHost } from '../src/broker/types.js';

describe('BotAccountBroker', () => {
  it('lease returns the configured token for a known host', async () => {
    const tokens = new Map<GitHost, string>([
      ['github', 'github-token-value'],
    ]);
    const broker = new BotAccountBroker(tokens);

    const lease = await broker.lease({
      host: 'github',
      repo: 'org/repo',
      taskId: 'task-1',
    });

    expect(lease.token).toBe('github-token-value');
    expect(lease.host).toBe('github');
    expect(lease.repo).toBe('org/repo');
  });

  it('lease throws an error for an unconfigured host', async () => {
    const tokens = new Map<GitHost, string>([
      ['github', 'github-token-value'],
    ]);
    const broker = new BotAccountBroker(tokens);

    await expect(
      broker.lease({
        host: 'gitlab',
        repo: 'org/repo',
        taskId: 'task-1',
      })
    ).rejects.toThrowError('no bot-account token configured for host "gitlab"');
  });

  it('error message for unconfigured host does not contain the configured token', async () => {
    const tokenValue = 'secret-github-token-12345';
    const tokens = new Map<GitHost, string>([
      ['github', tokenValue],
    ]);
    const broker = new BotAccountBroker(tokens);

    try {
      await broker.lease({
        host: 'gitlab',
        repo: 'org/repo',
        taskId: 'task-1',
      });
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain(tokenValue);
    }
  });

  it('revoke() is a safe no-op and does not throw', async () => {
    const tokens = new Map<GitHost, string>([
      ['github', 'github-token-value'],
    ]);
    const broker = new BotAccountBroker(tokens);

    const lease = await broker.lease({
      host: 'github',
      repo: 'org/repo',
      taskId: 'task-1',
    });

    // Should not throw.
    await lease.revoke();

    // Lease is still readable.
    expect(lease.token).toBe('github-token-value');
    expect(lease.host).toBe('github');
    expect(lease.repo).toBe('org/repo');
  });
});

describe('FakeBroker', () => {
  it('records lease requests in order', async () => {
    const fake = new FakeBroker();

    const req1: LeaseRequest = {
      host: 'github',
      repo: 'org1/repo1',
      taskId: 'task-1',
    };
    const req2: LeaseRequest = {
      host: 'gitlab',
      repo: 'org2/repo2',
      taskId: 'task-2',
    };

    await fake.lease(req1);
    await fake.lease(req2);

    expect(fake.leases).toHaveLength(2);
    expect(fake.leases[0]).toEqual(req1);
    expect(fake.leases[1]).toEqual(req2);
  });

  it('returns the fake token from the constructor', async () => {
    const fake = new FakeBroker('my-custom-token');

    const lease = await fake.lease({
      host: 'github',
      repo: 'org/repo',
      taskId: 'task-1',
    });

    expect(lease.token).toBe('my-custom-token');
  });

  it('returns the default token when none is provided', async () => {
    const fake = new FakeBroker();

    const lease = await fake.lease({
      host: 'github',
      repo: 'org/repo',
      taskId: 'task-1',
    });

    expect(lease.token).toBe('fake-token');
  });

  it('echoes host and repo from the lease request', async () => {
    const fake = new FakeBroker();

    const lease = await fake.lease({
      host: 'gitlab',
      repo: 'myorg/myrepo',
      taskId: 'task-123',
    });

    expect(lease.host).toBe('gitlab');
    expect(lease.repo).toBe('myorg/myrepo');
  });

  it('records revoke calls with the original request', async () => {
    const fake = new FakeBroker();

    const req: LeaseRequest = {
      host: 'github',
      repo: 'org/repo',
      taskId: 'task-1',
    };
    const lease = await fake.lease(req);

    await lease.revoke();

    expect(fake.revokes).toHaveLength(1);
    expect(fake.revokes[0]).toEqual(req);
  });

  it('tracks multiple revokes', async () => {
    const fake = new FakeBroker();

    const req1: LeaseRequest = {
      host: 'github',
      repo: 'org1/repo1',
      taskId: 'task-1',
    };
    const req2: LeaseRequest = {
      host: 'gitlab',
      repo: 'org2/repo2',
      taskId: 'task-2',
    };

    const lease1 = await fake.lease(req1);
    const lease2 = await fake.lease(req2);

    await lease1.revoke();
    await lease2.revoke();

    expect(fake.revokes).toHaveLength(2);
    expect(fake.revokes[0]).toEqual(req1);
    expect(fake.revokes[1]).toEqual(req2);
  });
});
