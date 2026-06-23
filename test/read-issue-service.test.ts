/**
 * Unit tests for RealReadIssueService (src/oneshot/read-issue-service.ts).
 *
 * Uses FakeBroker and an injected fetchFn so no Docker or network is needed.
 */

import { describe, it, expect } from 'vitest';
import { FakeBroker } from '../src/broker/fake.js';
import { RealReadIssueService, READ_ISSUE_BODY_MAX } from '../src/oneshot/read-issue-service.js';

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('RealReadIssueService', () => {
  it('rejects an invalid repo slug before leasing', async () => {
    const broker = new FakeBroker();
    const svc = new RealReadIssueService(broker);

    for (const bad of ['../etc/passwd', 'owner', 'owner/repo/extra', 'owner/re po', '']) {
      const outcome = await svc.readIssue({ host: 'github', repo: bad, number: 1 });
      expect(outcome.ok).toBe(false);
    }

    expect(broker.leases).toHaveLength(0);
  });

  it('rejects an invalid issue number before leasing', async () => {
    const broker = new FakeBroker();
    const svc = new RealReadIssueService(broker);

    const outcome1 = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 0 });
    expect(outcome1.ok).toBe(false);

    const outcome2 = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: -5 });
    expect(outcome2.ok).toBe(false);

    const outcome3 = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 1.5 });
    expect(outcome3.ok).toBe(false);

    expect(broker.leases).toHaveLength(0);
  });

  it('happy path: leases, fetches issue, revokes, returns issue data', async () => {
    const broker = new FakeBroker('test-gh-token');
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({
        title: 'Bug: NPE in login',
        body: 'Steps to reproduce...',
        state: 'open',
        user: { login: 'reporter' },
      }));

    const svc = new RealReadIssueService(broker, fakeFetch as typeof fetch);

    const outcome = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 7 });

    expect(outcome).toEqual({
      ok: true,
      issue: {
        title: 'Bug: NPE in login',
        body: 'Steps to reproduce...',
        state: 'open',
        author: 'reporter',
      },
    });
    expect(broker.leases).toHaveLength(1);
    expect(broker.leases[0]).toMatchObject({ host: 'github', repo: 'owner/repo' });
    expect(broker.revokes).toHaveLength(1);
  });

  it('caps an oversized body at READ_ISSUE_BODY_MAX', async () => {
    const broker = new FakeBroker();
    const oversizedBody = 'x'.repeat(READ_ISSUE_BODY_MAX + 1000);
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({
        title: 'Big issue',
        body: oversizedBody,
        state: 'open',
        user: { login: 'author' },
      }));

    const svc = new RealReadIssueService(broker, fakeFetch as typeof fetch);
    const outcome = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 1 });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.issue.body.length).toBe(READ_ISSUE_BODY_MAX);
    }
    // Lease is still revoked
    expect(broker.revokes).toHaveLength(1);
  });

  it('returns ok:false with reason on fetch error and still revokes the lease', async () => {
    const broker = new FakeBroker();
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({ message: 'Not Found' }, 404));

    const svc = new RealReadIssueService(broker, fakeFetch as typeof fetch);
    const outcome = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 999 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('404');
      // Token must never appear in the reason
      expect(outcome.reason).not.toContain('fake-token');
    }
    // Lease revoked even on error
    expect(broker.revokes).toHaveLength(1);
  });

  it('returns ok:false on broker throw and does not revoke (no lease acquired)', async () => {
    const broker = new FakeBroker();
    broker.lease = async () => { throw new Error('broker failed'); };
    const fakeFetch = (): Promise<Response> => Promise.resolve(makeResponse({}));
    const svc = new RealReadIssueService(broker, fakeFetch as typeof fetch);

    const outcome = await svc.readIssue({ host: 'github', repo: 'owner/repo', number: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('credential lease failed');
    }
    // No revoke since we never got a lease
    expect(broker.revokes).toHaveLength(0);
  });
});
