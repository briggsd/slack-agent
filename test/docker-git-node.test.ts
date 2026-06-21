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
import { DIFF_BASE_REF, DockerGitNodeExecutor, credentialHelper } from '../src/oneshot/docker-git-node.js';
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

interface FakeSpawnOpts {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function makeFakeSpawn(exitCodeOrOpts: number | FakeSpawnOpts = 0): { spawnFn: SpawnFn; calls: SpawnCall[] } {
  const opts: FakeSpawnOpts = typeof exitCodeOrOpts === 'number'
    ? { exitCode: exitCodeOrOpts }
    : exitCodeOrOpts;
  const exitCode = opts.exitCode ?? 0;
  const calls: SpawnCall[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const fake = new FakeChildProcess();
    calls.push({ command, args, options, fake });
    // Simulate immediate exit, optionally writing output first
    setImmediate(() => {
      if (opts.stdout !== undefined) fake.stdout.push(opts.stdout);
      if (opts.stderr !== undefined) fake.stderr.push(opts.stderr);
      fake.simulateExit(exitCode);
    });
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

    expect(calls).toHaveLength(2);
    const { command, args } = calls[0]!;
    expect(command).toBe('docker');
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--name');
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toMatch(/^slackbot-git-clone-owner-repo-/);
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

    // Entrypoint forced to git, before the image (the runner image's default
    // entrypoint runs the agent, so git args alone would be ignored).
    const epIdx = args.indexOf('--entrypoint');
    expect(epIdx).toBeGreaterThan(-1);
    expect(args[epIdx + 1]).toBe('git');
    expect(epIdx).toBeLessThan(args.indexOf(image));

    // git clone present (clone is git's arg; the entrypoint supplies `git`)
    expect(args).toContain('clone');
    expect(args).toContain('https://github.com/owner/repo.git');
    expect(args).toContain(workdir);

    // Security opt
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
  });

  it('records a stable local diff-base ref after clone', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume, shallow: true });

    expect(calls).toHaveLength(2);
    const cloneArgs = calls[0]?.args ?? [];
    expect(cloneArgs).toContain('clone');
    expect(cloneArgs).toContain('--depth');
    expect(cloneArgs).toContain('--single-branch');

    const baseRefCall = calls[1]!;
    expect(baseRefCall.command).toBe('docker');
    expect(baseRefCall.args).toContain('--entrypoint');
    expect(baseRefCall.args[baseRefCall.args.indexOf('--entrypoint') + 1]).toBe('git');
    expect(baseRefCall.args).toContain('-C');
    expect(baseRefCall.args).toContain(workdir);
    expect(baseRefCall.args).toContain('update-ref');
    expect(baseRefCall.args).toContain(DIFF_BASE_REF);
    expect(baseRefCall.args).toContain('HEAD');

    const env = baseRefCall.options.env as Record<string, string | undefined>;
    expect(env['GIT_TOKEN']).toBe('');
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

  it('TIMEOUT: a clone that never exits is killed and rejects (no token in message)', async () => {
    // A spawn that returns a child which never emits exit/error — a stalled `docker run`.
    let killed = false;
    const fake = new FakeChildProcess();
    fake.kill = (): boolean => { killed = true; return true; };
    const calls: SpawnCall[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options, fake });
      return fake.asChildProcess();
    };
    // Tiny timeout so the real timer fires fast; default is 120s.
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, cloneTimeoutMs: 10 });

    await expect(
      exec.clone({ lease: makeLease(token), repo: 'owner/repo', workdir, volume }),
    ).rejects.toThrow(/git clone timed out/);
    expect(killed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain('--name');
    const nameIdx = calls[0]?.args.indexOf('--name') ?? -1;
    const containerName = calls[0]?.args[nameIdx + 1];
    expect(containerName).toMatch(/^slackbot-git-clone-owner-repo-/);
    expect(calls[1]?.args).toEqual(['rm', '-f', containerName]);
    const cleanupEnv = calls[1]?.options.env as Record<string, string | undefined>;
    expect(cleanupEnv['GIT_TOKEN']).toBeUndefined();
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

// ── DockerGitNodeExecutor — verifyRepo ────────────────────────────────────────

describe('DockerGitNodeExecutor — verifyRepo', () => {
  const image = 'slackbot-runner:test';
  const volume = 'slackbot-ws-team01-c123-t456';
  const workdir = '/workspace/owner-repo';

  it('runs a credential-free git remote check and returns true when origin matches repo', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdout: 'https://github.com/owner/repo.git\n' });
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await expect(exec.verifyRepo({ repo: 'owner/repo', workdir, volume })).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    const { args, options } = calls[0]!;
    expect(args).toContain('remote');
    expect(args).toContain('get-url');
    expect(args).toContain('origin');
    expect(args).toContain(workdir);
    const env = options.env as Record<string, string | undefined>;
    expect(env['GIT_TOKEN']).toBeUndefined();
  });

  it('returns false when origin points at a different repo', async () => {
    const { spawnFn } = makeFakeSpawn({ stdout: 'https://github.com/other/repo.git\n' });
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await expect(exec.verifyRepo({ repo: 'owner/repo', workdir, volume })).resolves.toBe(false);
  });

  it('returns false when git cannot read the remote', async () => {
    const { spawnFn } = makeFakeSpawn({ exitCode: 128, stderr: 'not a git repository' });
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await expect(exec.verifyRepo({ repo: 'owner/repo', workdir, volume })).resolves.toBe(false);
  });
});

// ── DockerGitNodeExecutor — push ──────────────────────────────────────────────

describe('DockerGitNodeExecutor — push', () => {
  const image = 'slackbot-runner:test';
  const volume = 'slackbot-ws-team01-c123-t456';
  const workdir = '/workspace/owner-repo';
  const branch = 'slackbot/oneshot-task-001';
  const token = 'ghp-super-secret-push-token';

  it('spawns docker run with git -C <workdir> push origin HEAD:<branch>', async () => {
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

    // Entrypoint forced to git, before the image
    const epIdx = args.indexOf('--entrypoint');
    expect(epIdx).toBeGreaterThan(-1);
    expect(args[epIdx + 1]).toBe('git');
    expect(epIdx).toBeLessThan(args.indexOf(image));

    // git -C <workdir> push origin HEAD:<branch> (git supplied by the entrypoint).
    // HEAD:<branch> creates the remote branch from the cloned tree's current HEAD —
    // see the push() comment for why the bare-<branch> refspec cannot work.
    expect(args).toContain('-C');
    expect(args).toContain(workdir);
    expect(args).toContain('push');
    expect(args).toContain('origin');
    expect(args).toContain(`HEAD:${branch}`);
    expect(args).not.toContain(branch);

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

// ── DockerGitNodeExecutor — runCheck ─────────────────────────────────────────

describe('DockerGitNodeExecutor — runCheck', () => {
  const image = 'slackbot-runner:test';
  const volume = 'slackbot-ws-team01-c123-t456';
  const workdir = '/workspace/acme-widgets';

  it('lint: builds correct argv (sh entrypoint, -w workdir, NO -e GIT_TOKEN, default shell cmd)', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe('docker');
    expect(args).toContain('run');
    expect(args).toContain('--rm');

    // Volume mount
    const vIdx = args.indexOf('-v');
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe(`${volume}:/workspace`);

    // Working directory flag
    const wIdx = args.indexOf('-w');
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe(workdir);

    // Entrypoint is sh, not git
    const epIdx = args.indexOf('--entrypoint');
    expect(epIdx).toBeGreaterThan(-1);
    expect(args[epIdx + 1]).toBe('sh');

    // Security opt
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');

    // Image present
    expect(args).toContain(image);

    // -c with the default auto-detect shell command
    const cIdx = args.indexOf('-c');
    expect(cIdx).toBeGreaterThan(-1);
    const shellCmd = args[cIdx + 1] ?? '';
    expect(shellCmd).toContain('package.json');
    expect(shellCmd).toContain('npm run lint');
    expect(shellCmd).toContain('if [');  // uses if/then/else, not &&/||
    expect(shellCmd).toContain('skipping'); // skip path when nothing to run

    // NO -e GIT_TOKEN (checks get no credential)
    expect(args).not.toContain('GIT_TOKEN');
    const eIdx = args.indexOf('-e');
    expect(eIdx).toBe(-1);
  });

  it('test: default shell cmd runs "npm run test" guarded by script detection', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.runCheck({ kind: 'test', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    const shellCmd = args[cIdx + 1] ?? '';
    expect(shellCmd).toContain('npm run test');
    expect(shellCmd).toContain('package.json');
  });

  it('uses lintCmd override when configured', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint' });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('make lint');
  });

  it('uses testCmd override when configured', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, testCmd: 'make test' });

    await exec.runCheck({ kind: 'test', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('make test');
  });

  it('a non-zero exit RESOLVES with that exitCode (does not reject)', async () => {
    const { spawnFn } = makeFakeSpawn(2);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.exitCode).toBe(2);
  });

  it('captures combined stdout+stderr into output', async () => {
    const { spawnFn } = makeFakeSpawn({ exitCode: 1, stdout: 'lint error line\n', stderr: 'from stderr\n' });
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('lint error line');
    expect(result.output).toContain('from stderr');
  });

  it('CREDENTIAL BOUNDARY: no GIT_TOKEN in spawn env for checks', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const env = calls[0]!.options.env as Record<string, string | undefined>;
    expect(env['GIT_TOKEN']).toBeUndefined();
  });

  it('lintCmd override does NOT also appear for test kind', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint' });

    await exec.runCheck({ kind: 'test', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    // test kind should get the auto-detect default, not 'make lint'
    expect(args[cIdx + 1]).not.toBe('make lint');
    expect(args[cIdx + 1]).toContain('npm run test');
  });

  it('a skip exit (default, no script) RESOLVES with skipped=true and exitCode normalized to 0', async () => {
    // 97 is the reserved skip code the auto-detect command exits with when there is
    // nothing to run; runCheck maps it to { skipped: true, exitCode: 0 }.
    const { spawnFn } = makeFakeSpawn(97);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.skipped).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('a passing default check is NOT skipped (exitCode 0, skipped=false)', async () => {
    const { spawnFn } = makeFakeSpawn(0);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('an override is never marked skipped, even if it exits with the reserved code', async () => {
    // With an override configured, exit 97 is the override command's own code, not a skip.
    const { spawnFn } = makeFakeSpawn(97);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint' });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(97);
  });

  // ── Per-repo override tests ───────────────────────────────────────────────

  it('per-repo lint override runs that exact command with skipped:false', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['acme/widgets', { lint: 'ruff check .' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, checkCmds });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('ruff check .');
    expect(result.skipped).toBe(false);
  });

  it('per-repo test override runs that exact command with skipped:false', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['acme/api', { test: 'pytest' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, checkCmds });

    const result = await exec.runCheck({ kind: 'test', repo: 'acme/api', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('pytest');
    expect(result.skipped).toBe(false);
  });

  it('per-repo override takes precedence over a configured global lintCmd', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['acme/widgets', { lint: 'ruff check .' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint', checkCmds });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    // per-repo wins over global
    expect(args[cIdx + 1]).toBe('ruff check .');
  });

  it('repo NOT in the map falls back to the global lintCmd override', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['other/repo', { lint: 'ruff check .' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint', checkCmds });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('make lint');
  });

  it('repo NOT in the map falls back to npm auto-detect shellCmd when no global override', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['other/repo', { lint: 'ruff check .' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, checkCmds });

    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    const shellCmd = args[cIdx + 1] ?? '';
    expect(shellCmd).toContain('npm run lint');
    expect(shellCmd).toContain('package.json');
  });

  it('per-repo entry with only test leaves lint for that repo on the fallback path', async () => {
    const { spawnFn, calls } = makeFakeSpawn(0);
    const checkCmds = new Map([['acme/widgets', { test: 'pytest' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, lintCmd: 'make lint', checkCmds });

    // lint kind: per-repo has only test, so lint falls through to global lintCmd
    await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });

    const { args } = calls[0]!;
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('make lint');
  });

  it('per-repo override is never marked skipped even if it exits with reserved code 97', async () => {
    const { spawnFn } = makeFakeSpawn(97);
    const checkCmds = new Map([['acme/widgets', { lint: 'ruff check .' }]]);
    const exec = new DockerGitNodeExecutor({ image, spawn: spawnFn, checkCmds });

    const result = await exec.runCheck({ kind: 'lint', repo: 'acme/widgets', workdir, volume });
    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(97);
  });
});
