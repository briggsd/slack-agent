import { describe, it, expect } from 'vitest';
import { GithubProvider } from '../src/oneshot/git-host.js';

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('GithubProvider — PR mutation APIs', () => {
  const provider = new GithubProvider();

  it('getChangeRequestByHead GETs pulls filtered by owner:branch and returns the first open PR', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse([
        { html_url: 'https://github.com/owner/repo/pull/7', number: 7, head: { sha: 'head-7' } },
        { html_url: 'https://github.com/owner/repo/pull/8', number: 8, head: { sha: 'head-8' } },
      ]));
    };

    const result = await provider.getChangeRequestByHead({
      repo: 'owner/repo',
      head: 'slackbot/oneshot-task',
      token: 'tok-head',
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result).toEqual({
      url: 'https://github.com/owner/repo/pull/7',
      number: 7,
      headSha: 'head-7',
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/pulls?head=owner%3Aslackbot%2Foneshot-task&state=open',
    );
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-head');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('slack-agent');
  });

  it('getChangeRequestByHead returns null for an empty list', async () => {
    const fakeFetch = (): Promise<Response> => Promise.resolve(makeResponse([]));

    await expect(provider.getChangeRequestByHead({
      repo: 'owner/repo',
      head: 'branch',
      token: 'tok',
      fetchFn: fakeFetch as typeof fetch,
    })).resolves.toBeNull();
  });

  it('getChangeRequestByHead throws on non-2xx without leaking the token', async () => {
    const token = 'secret-head-token';
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({ message: 'Bad credentials' }, 401));

    await expect(provider.getChangeRequestByHead({
      repo: 'owner/repo',
      head: 'branch',
      token,
      fetchFn: fakeFetch as typeof fetch,
    })).rejects.toThrow('GitHub API error 401');

    await provider.getChangeRequestByHead({
      repo: 'owner/repo',
      head: 'branch',
      token,
      fetchFn: fakeFetch as typeof fetch,
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        expect(err.message).not.toContain(token);
      }
    });
  });

  it('editChangeRequest PATCHes only the provided fields', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse({ html_url: 'https://github.com/owner/repo/pull/9' }));
    };

    const result = await provider.editChangeRequest({
      repo: 'owner/repo',
      number: 9,
      token: 'tok-edit',
      fetchFn: fakeFetch as typeof fetch,
      body: 'Updated body only',
    });

    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/9' });
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls/9');
    expect(fetchCalls[0]?.init.method).toBe('PATCH');
    const body = JSON.parse((fetchCalls[0]?.init.body as string) ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({ body: 'Updated body only' });
  });

  it('addChangeRequestComment POSTs an issue comment body', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse({ html_url: 'https://github.com/owner/repo/pull/9#issuecomment-1' }));
    };

    const result = await provider.addChangeRequestComment({
      repo: 'owner/repo',
      number: 9,
      token: 'tok-comment',
      fetchFn: fakeFetch as typeof fetch,
      comment: 'Please re-run checks.',
    });

    expect(result).toEqual({ url: 'https://github.com/owner/repo/pull/9#issuecomment-1' });
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/owner/repo/issues/9/comments');
    expect(fetchCalls[0]?.init.method).toBe('POST');
    expect(JSON.parse((fetchCalls[0]?.init.body as string) ?? '{}')).toEqual({
      body: 'Please re-run checks.',
    });
  });
});
