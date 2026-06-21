import { describe, it, expect } from 'vitest';
import { RealPrStateReader } from '../src/oneshot/pr-state-reader.js';
import { FakeBroker } from '../src/broker/fake.js';

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('RealPrStateReader', () => {
  it('leases github credentials, reads PR state, and revokes the lease', async () => {
    const broker = new FakeBroker('bot-token');
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse({
        merged: false,
        state: 'open',
        head: { sha: 'head-sha' },
      }));
    };
    const reader = new RealPrStateReader(broker, fakeFetch as typeof fetch);

    await expect(reader.getState({ repo: 'owner/repo', number: 17 })).resolves.toEqual({
      status: 'open',
      headSha: 'head-sha',
    });

    expect(broker.leases).toEqual([{
      host: 'github',
      repo: 'owner/repo',
      taskId: 'pr-reconcile:owner/repo#17',
    }]);
    expect(broker.revokes).toEqual(broker.leases);
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls/17');
  });

  it('revokes the lease even when the provider read fails', async () => {
    const broker = new FakeBroker('bot-token');
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({ message: 'Not Found' }, 404));
    const reader = new RealPrStateReader(broker, fakeFetch as typeof fetch);

    await expect(reader.getState({ repo: 'owner/repo', number: 18 })).rejects.toThrow(
      'GitHub API error 404',
    );

    expect(broker.revokes).toEqual([{
      host: 'github',
      repo: 'owner/repo',
      taskId: 'pr-reconcile:owner/repo#18',
    }]);
  });
});
