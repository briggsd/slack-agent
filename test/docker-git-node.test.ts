/**
 * Unit tests for DockerGitNodeExecutor and GithubProvider / providerFor.
 *
 * Everything is offline — no real Docker, no network, no git.
 * - Spawn is injected via a FakeChildProcess + fake SpawnFn.
 * - HTTP is injected via a fake fetchFn returning canned Response-likes.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { DockerGitNodeExecutor, credentialHelper } from '../src/oneshot/docker-git-node.js';
import { GithubProvider, providerFor } from '../src/oneshot/git-host.js';
import type { SpawnFn } from '../src/runner/docker.js';
import type { CredentialLease } from '../src/broker/types.js';

// ── FakeChildProcess (mirrored from test/docker.test.ts) ─────────────────────

class FakeChildProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  simulateExit(code: number | null = 0): void {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  kill(): boolean {
    return true;
  }
}

// ── Fake spawn helper ─────────────────────────────────────────────────────────

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  fake: FakeChildProcess;
}

function makeFakeSpawn(exitCode = 0): { spawnFn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const fake = new FakeChildProcess();
    calls.push({ command, args, options, fake });
    // Simulate immediate exit
    setImmediate(() => fake.simulateExit(exitCode));
    return fake.asChildProcess();
  };
  return { spawnFn, calls };
}

// ── Fake fetch helper ─────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ── Fake lease ────────────────────────────────────────────────────────────────

function makeLease(token = 'tok-secret-12345'): CredentialLease {
  return {
    token,
    host: 'github',
    repo: 'owner/repo',
    revoke: async () => { /* no-op */ },
  };
}

// ── GithubProvider ────────────────────────────────────────────────────────────

describe('GithubProvider', () => {
  const provider = new GithubProvider();

  it('cloneUrl returns the HTTPS .git URL with no secret embedded', () => {
    expect(provider.cloneUrl('acme/widgets')).toBe('https://github.com/acme/widgets.git');
  });

  it('cloneUrl works for org/subgroup slugs', () => {
    expect(provider.cloneUrl('myorg/myrepo')).toBe('https://github.com/myorg/myrepo.git');
  });

  it('credentialUsername returns x-access-token', () => {
    expect(provider.credentialUsername()).toBe('x-access-token');
  });

  it('defaultBranch GETs the repo endpoint with correct headers and reads default_branch', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse({ default_branch: 'trunk', name: 'widgets' }));
    };

    const branch = await provider.defaultBranch('acme/widgets', 'tok-abc', fakeFetch as typeof fetch);

    expect(branch).toBe('trunk');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/acme/widgets');

    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-abc');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('slack-agent');
  });

  it('defaultBranch throws (without leaking token) on non-2xx response', async () => {
    const token = 'very-secret-token';
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({ message: 'Not Found' }, 404));

    await expect(provider.defaultBranch('owner/repo', token, fakeFetch as typeof fetch))
      .rejects.toThrow('GitHub API error 404');

    // Ensure the error message does not contain the token
    await provider.defaultBranch('owner/repo', token, fakeFetch as typeof fetch).catch((err: unknown) => {
      if (err instanceof Error) {
        expect(err.message).not.toContain(token);
      }
    });
  });

  it('openChangeRequest POSTs to the pulls endpoint with correct body and headers', async () => {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(makeResponse({ html_url: 'https://github.com/owner/repo/pull/7', number: 7 }));
    };

    const result = await provider.openChangeRequest({
      repo: 'owner/repo',
      head: 'feature/my-change',
      base: 'main',
      title: 'Add CHANGELOG',
      body: 'Automated implementation.',
      token: 'tok-xyz',
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result.url).toBe('https://github.com/owner/repo/pull/7');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect(fetchCalls[0]?.init.method).toBe('POST');

    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-xyz');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('slack-agent');

    const bodyStr = fetchCalls[0]?.init.body as string;
    const body = JSON.parse(bodyStr) as { title: string; head: string; base: string; body: string };
    expect(body.title).toBe('Add CHANGELOG');
    expect(body.head).toBe('feature/my-change');
    expect(body.base).toBe('main');
    expect(body.body).toBe('Automated implementation.');
  });

  it('openChangeRequest throws (without leaking token) on non-2xx response', async () => {
    const token = 'secret-pr-token';
    const fakeFetch = (): Promise<Response> =>
      Promise.resolve(makeResponse({ message: 'Unprocessable Entity' }, 422));

    await expect(provider.openChangeRequest({
      repo: 'owner/repo', head: 'feat', base: 'main',
      title: 'T', body: 'B', token, fetchFn: fakeFetch as typeof fetch,
    })).rejects.toThrow('GitHub API error 422');

    // Error must not contain the token
    await provider.openChangeRequest({
      repo: 'owner/repo', head: 'feat', base: 'main',
      title: 'T', body: 'B', token, fetchFn: fakeFetch as typeof fetch,
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        expect(err.message).not.toContain(token);
      }
    });
  });
});

// ── credentialHelper (shell-injection guard) ─────────────────────────────────

describe('credentialHelper', () => {
  it('builds a helper for a safe username', () => {
    const helper = credentialHelper('x-access-token');
    expect(helper).toContain('username=x-access-token');
    expect(helper).toContain('password=$GIT_TOKEN');
  });

  it('rejects a username with shell metacharacters', () => {
    expect(() => credentialHelper('x"; rm -rf / #')).toThrow(/unsafe git credential username/i);
    expect(() => credentialHelper('$(whoami)')).toThrow(/unsafe/i);
  });
});

// ── providerFor ────────────────────────────────────────────────────────────────

describe('providerFor', () => {
  it('returns a GithubProvider for github', () => {
    const p = providerFor('github');
    expect(p).toBeInstanceOf(GithubProvider);
  });

  it('throws a clear "not yet supported" error for gitlab', () => {
    expect(() => providerFor('gitlab')).toThrow(/not yet supported/i);
    expect(() => providerFor('gitlab')).toThrow(/gitlab/i);
  });
});

// ── DockerGitNodeExecutor — clone ─────────────────────────────────────────────

describe('DockerGitNodeExecutor — clone', () => {
  const image = 'slackbot-runner:test';
  const volume = 'slackbot-ws-team01-c123-t456';
  const workdir = '/workspace/owner-repo';
  const token = 'ghp-super-secret-token';

  it('spawns docker run with correct argv shape (volume, -e GIT_TOKEN name-only, image, git clone)', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });
    const lease = makeLease(token);

    await exec.clone({ lease, repo: 'owner/repo', workdir, volume });

    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe('docker');
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('-e');

    // Volume mount
    const vIdx = args.indexOf('-v');
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe(`${volume}:/workspace`);

    // GIT_TOKEN by name only
    const eIdx = args.indexOf('-e');
    expect(eIdx).toBeGreaterThan(-1);
    expect(args[eIdx + 1]).toBe('GIT_TOKEN');

    // Image
    expect(args).toContain(image);

    // git clone present
    expect(args).toContain('git');
    expect(args).toContain('clone');
    expect(args).toContain('https://github.com/owner/repo.git');
    expect(args).toContain(workdir);

    // Security opt
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  it('CREDENTIAL BOUNDARY: token is in spawn env.GIT_TOKEN and NOT anywhere in argv', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume });

    const { args, options } = calls[0]!;

    // Token must NOT appear in any argv element
    expect(args.join(' ')).not.toContain(token);

    // Token MUST appear in spawn options.env.GIT_TOKEN
    const env = options.env as Record<string, string>;
    expect(env['GIT_TOKEN']).toBe(token);
  });

  it('ENV HYGIENE: the docker CLI child env does NOT inherit host secrets (e.g. ANTHROPIC_API_KEY)', async () => {
    const SENTINEL = 'anthropic-secret-should-not-leak';
    const prev = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = SENTINEL;
    try {
      const { spawnFn, calls } = makeFakeSpawn(0);
      const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });
      await exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume });

      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env['GIT_TOKEN']).toBe(token);
      // No host secret forwarded to the docker CLI child.
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });

  it('rejects with an Error (no token in message) when docker exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn(128);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await expect(
      exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume }),
    ).rejects.toThrow('git clone failed');

    // Error message must not contain the token
    await exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume })
      .catch((err: unknown) => {
        if (err instanceof Error) {
          expect(err.message).not.toContain(token);
        }
      });
  });
});

// ── DockerGitNodeExecutor — push ──────────────────────────────────────────────

describe('DockerGitNodeExecutor — push', () => {
  const image = 'slackbot-runner:test';
  const volume = 'slackbot-ws-team01-c123-t456';
  const workdir = '/workspace/owner-repo';
  const branch = 'slackbot/oneshot-task-001';
  const token = 'ghp-super-secret-push-token';

  it('spawns docker run with git -C <workdir> push origin <branch>', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.push({ lease: makeLease(token), repo: 'owner/repo', branch, workdir, volume });

    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe('docker');
    expect(args).toContain('run');
    expect(args).toContain('--rm');

    // Volume mount
    const vIdx = args.indexOf('-v');
    expect(args[vIdx + 1]).toBe(`${volume}:/workspace`);

    // -e GIT_TOKEN name-only
    const eIdx = args.indexOf('-e');
    expect(args[eIdx + 1]).toBe('GIT_TOKEN');

    // git -C <workdir> push origin <branch>
    expect(args).toContain('git');
    expect(args).toContain('-C');
    expect(args).toContain(workdir);
    expect(args).toContain('push');
    expect(args).toContain('origin');
    expect(args).toContain(branch);

    // Security opt
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  it('CREDENTIAL BOUNDARY: token is in spawn env.GIT_TOKEN and NOT anywhere in argv', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.push({ lease: makeLease(token), repo: 'owner/repo', branch, workdir, volume });

    const { args, options } = calls[0]!;

    // Token must NOT appear in any argv element
    expect(args.join(' ')).not.toContain(token);

    // Token MUST appear in spawn options.env.GIT_TOKEN
    const env = options.env as Record<string, string>;
    expect(env['GIT_TOKEN']).toBe(token);
  });

  it('rejects with an Error (no token in message) when docker exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn(1);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await expect(
      exec.push({ lease: makeLease(token), repo: 'owner/repo', branch, workdir, volume }),
    ).rejects.toThrow('git push failed');

    await exec.push({ lease: makeLease(token), repo: 'owner/repo', branch, workdir, volume })
      .catch((err: unknown) => {
        if (err instanceof Error) {
          expect(err.message).not.toContain(token);
        }
      });
  });
});

// ── DockerGitNodeExecutor — openChangeRequest ─────────────────────────────────

describe('DockerGitNodeExecutor — openChangeRequest', () => {
  const image = 'slackbot-runner:test';
  const token = 'ghp-pr-token';

  function makeFetch(defaultBranch: string, prUrl: string, prStatus = 200): {
    fetchFn: typeof fetch;
    fetchCalls: { url: string; init: RequestInit }[];
  } {
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      const urlStr = String(url);
      if (urlStr.endsWith('/pulls')) {
        return Promise.resolve(makeResponse({ html_url: prUrl }, prStatus));
      }
      // repo metadata
      return Promise.resolve(makeResponse({ default_branch: defaultBranch, name: 'repo' }));
    };
    return { fetchFn: fetchFn as typeof fetch, fetchCalls };
  }

  it('first GETs repo metadata then POSTs the PR', async () => {
    const { spawnFn } = makeFakeSpawn(0);
    const { fetchFn, fetchCalls } = makeFetch('develop', 'https://github.com/owner/repo/pull/9');
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, fetchFn });
    const lease = makeLease(token);

    const result = await exec.openChangeRequest({
      lease,
      repo: 'owner/repo',
      head: 'slackbot/oneshot-task-001',
      base: 'main', // ignored — real base detected
      title: 'Add CHANGELOG',
      body: 'done',
    });

    expect(result.url).toBe('https://github.com/owner/repo/pull/9');
    expect(fetchCalls).toHaveLength(2);
    // First call: GET repo metadata
    expect(fetchCalls[0]?.url).toBe('https://api.github.com/repos/owner/repo');
    // Second call: POST pulls
    expect(fetchCalls[1]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect(fetchCalls[1]?.init.method).toBe('POST');
  });

  it('uses the DETECTED default branch (not the request base) in the PR POST body', async () => {
    const { spawnFn } = makeFakeSpawn(0);
    const { fetchFn, fetchCalls } = makeFetch('master', 'https://github.com/owner/repo/pull/3');
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, fetchFn });

    await exec.openChangeRequest({
      lease: makeLease(token),
      repo: 'owner/repo',
      head: 'slackbot/oneshot-task-002',
      base: 'main', // should be ignored
      title: 'Fix bug',
      body: 'details',
    });

    // The POST body must use 'master' (detected), not 'main' (request.base)
    const bodyStr = fetchCalls[1]?.init.body as string;
    const body = JSON.parse(bodyStr) as { base: string };
    expect(body.base).toBe('master');
    expect(body.base).not.toBe('main');
  });

  it('Authorization header carries Bearer <token> in both GET and POST', async () => {
    const { spawnFn } = makeFakeSpawn(0);
    const { fetchFn, fetchCalls } = makeFetch('main', 'https://github.com/owner/repo/pull/1');
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, fetchFn });

    await exec.openChangeRequest({
      lease: makeLease(token),
      repo: 'owner/repo',
      head: 'feat',
      base: 'main',
      title: 'T',
      body: 'B',
    });

    for (const call of fetchCalls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${token}`);
    }
  });

  it('rejects (without leaking token) when the PR POST returns non-2xx', async () => {
    const { spawnFn } = makeFakeSpawn(0);
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      const urlStr = String(url);
      if (urlStr.endsWith('/pulls')) {
        return Promise.resolve(makeResponse({ message: 'Unprocessable' }, 422));
      }
      return Promise.resolve(makeResponse({ default_branch: 'main' }));
    };
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, fetchFn: fetchFn as typeof fetch });

    await expect(exec.openChangeRequest({
      lease: makeLease(token),
      repo: 'owner/repo',
      head: 'feat', base: 'main', title: 'T', body: 'B',
    })).rejects.toThrow('GitHub API error 422');

    // Error must not leak the token
    await exec.openChangeRequest({
      lease: makeLease(token),
      repo: 'owner/repo',
      head: 'feat', base: 'main', title: 'T', body: 'B',
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        expect(err.message).not.toContain(token);
      }
    });
  });
});
