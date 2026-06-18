/**
 * DockerGitNodeExecutor — the real GitNodeExecutor.
 *
 * Clone and push run as ephemeral `docker run --rm` containers that mount the
 * session workspace volume and carry the per-lease token in their ENV (never in
 * argv). Opening a PR is a GitHub REST call via an injectable fetchFn.
 *
 * Credential boundary: GIT_TOKEN is passed via spawn's `env` option; the argv
 * uses `-e GIT_TOKEN` (name only), mirroring how docker.ts passes ANTHROPIC_API_KEY.
 * The inline git credential helper inside the container reads $GIT_TOKEN — the
 * token is never in any argv, URL, or log line.
 */

import { spawn as nodeSpawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { SpawnFn } from '../runner/docker.js';
import type { GitNodeExecutor, CloneRequest, PushRequest, OpenChangeRequest } from './git-node.js';
import { providerFor, type FetchFn } from './git-host.js';

/** Env vars the docker CLI itself may need; everything else (incl. host secrets) is dropped. */
const DOCKER_CLI_ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
] as const;

/**
 * Build the minimal environment for the docker CLI child: a small allowlist the CLI
 * needs, plus GIT_TOKEN. We deliberately do NOT spread `process.env` — the gateway's
 * environment holds other secrets (e.g. ANTHROPIC_API_KEY) that have no business near a
 * git operation. Only GIT_TOKEN is forwarded into the container (via `-e GIT_TOKEN`).
 */
function dockerCliEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TOKEN: token };
  for (const key of DOCKER_CLI_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A git credential username must be a plain token (it is interpolated into a shell helper). */
const SAFE_USERNAME = /^[A-Za-z0-9._-]+$/;

/** Build the inline git credential helper shell expression for the given username. */
export function credentialHelper(username: string): string {
  if (!SAFE_USERNAME.test(username)) {
    // The username is interpolated into a shell function run by git; reject anything
    // that could break out of it. Today it is a hardcoded provider constant, but this
    // guards a future GitHostProvider that returns something untrusted.
    throw new Error(`unsafe git credential username: ${username}`);
  }
  // The helper is called by git with an 'action' arg; we only respond to 'get'.
  // It reads $GIT_TOKEN from the container environment — never from argv.
  return `!f() { if [ "$1" = "get" ]; then echo "username=${username}"; echo "password=$GIT_TOKEN"; fi; }; f`;
}

/**
 * Spawn `docker <args>` with GIT_TOKEN in the env (never argv), capturing stderr so a
 * failure carries a diagnosable reason. Resolves on exit 0, rejects otherwise.
 * Git's credential exchange happens over its own channel, so container stderr carries
 * only error text (e.g. "Authentication failed") — never the token.
 */
function runDocker(
  spawnFn: SpawnFn,
  args: string[],
  token: string,
  what: string,
  context: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawnFn('docker', args, {
      env: dockerCliEnv(token),
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 500) {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    });

    child.once('error', (err) => reject(err));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().slice(0, 500);
      reject(new Error(`${what} failed (exit ${String(code)}) [${context}]${detail !== '' ? `: ${detail}` : ''}`));
    });
  });
}

export class DockerGitNodeExecutor implements GitNodeExecutor {
  private readonly image: string;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: FetchFn;

  constructor(opts: {
    image: string;
    spawn?: SpawnFn;
    fetchFn?: FetchFn;
  }) {
    this.image = opts.image;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /**
   * Build the `docker run` argv for a git command. The image is forced to run `git`
   * via `--entrypoint git` — the default git image here (slackbot-runner) has an
   * ENTRYPOINT that runs the agent, so passing git args without overriding the
   * entrypoint would silently run the agent instead of git.
   */
  private dockerRunArgs(volume: string, gitArgs: string[]): string[] {
    return [
      'run',
      '--rm',
      '-v', `${volume}:/workspace`,
      '-e', 'GIT_TOKEN',   // name-only: value inherited from spawn env, never in argv
      '--security-opt', 'no-new-privileges',
      '--entrypoint', 'git',
      this.image,
      ...gitArgs,
    ];
  }

  async clone(req: CloneRequest): Promise<void> {
    const provider = providerFor(req.lease.host);
    const cloneUrl = provider.cloneUrl(req.repo);
    const helper = credentialHelper(provider.credentialUsername());

    // git args (the entrypoint is git, so no leading 'git'). The credential helper
    // reads $GIT_TOKEN from the container env — no token in argv.
    const gitArgs = [
      '-c', `credential.helper=${helper}`,
      'clone',
      cloneUrl,
      req.workdir,
    ];

    const args = this.dockerRunArgs(req.volume, gitArgs);
    await runDocker(this.spawnFn, args, req.lease.token, 'git clone', `repo: ${req.repo}`);
  }

  async push(req: PushRequest): Promise<void> {
    const provider = providerFor(req.lease.host);
    const helper = credentialHelper(provider.credentialUsername());

    // git -C <workdir> push origin HEAD:<branch> (entrypoint is git, so no leading 'git').
    // Push the cloned working tree's current HEAD to the new remote branch. The agentic
    // implement step commits on whatever branch the clone left checked out (the repo's
    // default), and the orchestrator does not create a local branch named req.branch — so
    // pushing the bare `req.branch` refspec fails ("src refspec … does not match any").
    // The `HEAD:req.branch` form creates the remote branch from HEAD regardless of the
    // local branch name.
    const gitArgs = [
      '-C', req.workdir,
      '-c', `credential.helper=${helper}`,
      'push',
      'origin',
      `HEAD:${req.branch}`,
    ];

    const args = this.dockerRunArgs(req.volume, gitArgs);
    await runDocker(this.spawnFn, args, req.lease.token, 'git push', `repo: ${req.repo}, branch: ${req.branch}`);
  }

  async openChangeRequest(req: OpenChangeRequest): Promise<{ url: string }> {
    const provider = providerFor(req.lease.host);

    // Detect the repo's real default branch — not a hardcoded 'main'
    const detectedBase = await provider.defaultBranch(req.repo, req.lease.token, this.fetchFn);

    return provider.openChangeRequest({
      repo: req.repo,
      head: req.head,
      base: detectedBase,
      title: req.title,
      body: req.body,
      token: req.lease.token,
      fetchFn: this.fetchFn,
    });
  }
}
