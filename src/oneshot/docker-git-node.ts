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
import type { GitNodeExecutor, CloneRequest, BranchRequest, PushRequest, OpenChangeRequest, CheckRequest, CheckResult } from './git-node.js';
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
 * Reserved exit code the auto-detect check command uses to signal "nothing to run"
 * (no package.json or no matching npm script), so a skip is distinguishable from a
 * pass. Chosen to avoid common lint/test failure codes (typically 1–2).
 */
const CHECK_SKIP_EXIT = 97;

/**
 * Spawn `docker <args>` without any secret in the env, capturing combined stdout+stderr.
 * Resolves with { exitCode, output } regardless of the exit code — a non-zero exit is
 * returned as data, not thrown. Rejects only on a true spawn/infrastructure error (the
 * child's `error` event). Output is capped to 4 KB to avoid runaway memory.
 */
function runDockerCapture(
  spawnFn: SpawnFn,
  args: string[],
  what: string,
  context: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const child: ChildProcess = spawnFn('docker', args, {
      env: dockerCheckEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const CAP = 4 * 1024; // 4 KB
    let output = '';
    const onChunk = (chunk: Buffer | string): void => {
      if (output.length >= CAP) return;
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      // Clamp per-chunk so a single huge chunk can't blow the cap before resolve.
      output += s.slice(0, CAP - output.length);
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.once('error', (err) => {
      reject(new Error(`${what} spawn error [${context}]: ${String(err)}`));
    });
    // 'close' (not 'exit') so all stdout/stderr `data` events have flushed before we resolve.
    child.once('close', (code) => {
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

/**
 * Build the minimal environment for a check container: only the docker CLI's own
 * needs. No GIT_TOKEN — checks get no credential (defense-in-depth).
 */
function dockerCheckEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DOCKER_CLI_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Spawn `docker <args>` with GIT_TOKEN in the env (never argv), capturing stderr so a
 * failure carries a diagnosable reason. Resolves on exit 0, rejects otherwise.
 * Git's credential exchange happens over its own channel, so container stderr carries
 * only error text (e.g. "Authentication failed") — never the token.
 *
 * When `timeoutMs` is set, a stalled op (network/daemon hang) is bounded: the child is
 * SIGKILLed and the promise rejects with a timeout error rather than pending forever.
 * The conversational clone path passes one so a hung `docker run git clone` cannot wedge
 * the turn (and the in-container `clone_repo` tool parked on its result) indefinitely.
 */
function runDocker(
  spawnFn: SpawnFn,
  args: string[],
  token: string,
  what: string,
  context: string,
  timeoutMs?: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawnFn('docker', args, {
      env: dockerCliEnv(token),
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 500) {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // Kill the stalled child; `docker run --rm` cleans the container on the client's death.
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        settle(() => reject(new Error(`${what} timed out after ${String(timeoutMs)}ms [${context}]`)));
      }, timeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
    }

    child.once('error', (err) => settle(() => reject(err)));
    child.once('exit', (code) => settle(() => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().slice(0, 500);
      reject(new Error(`${what} failed (exit ${String(code)}) [${context}]${detail !== '' ? `: ${detail}` : ''}`));
    }));
  });
}

/** Default bound on a single clone (ms). Generous for a shallow clone; just a liveness
 *  guard so a stalled `docker run git clone` can't hang the turn. Not a tuning knob. */
const DEFAULT_CLONE_TIMEOUT_MS = 120_000;

export class DockerGitNodeExecutor implements GitNodeExecutor {
  private readonly image: string;
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: FetchFn;
  private readonly lintCmd: string | undefined;
  private readonly testCmd: string | undefined;
  private readonly checkCmds: ReadonlyMap<string, { lint?: string; test?: string }>;
  private readonly cloneTimeoutMs: number;

  constructor(opts: {
    image: string;
    spawn?: SpawnFn;
    fetchFn?: FetchFn;
    lintCmd?: string;
    testCmd?: string;
    checkCmds?: ReadonlyMap<string, { lint?: string; test?: string }>;
    /** Bound on a single clone in ms (default 120000). A stalled clone is killed and rejects. */
    cloneTimeoutMs?: number;
  }) {
    this.image = opts.image;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.lintCmd = opts.lintCmd;
    this.testCmd = opts.testCmd;
    this.checkCmds = opts.checkCmds ?? new Map();
    this.cloneTimeoutMs = opts.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
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
    const gitArgs: string[] = [
      '-c', `credential.helper=${helper}`,
      'clone',
      ...(req.shallow === true ? ['--depth', '1', '--single-branch'] : []),
      cloneUrl,
      req.workdir,
    ];

    const args = this.dockerRunArgs(req.volume, gitArgs);
    await runDocker(this.spawnFn, args, req.lease.token, 'git clone', `repo: ${req.repo}`, this.cloneTimeoutMs);
  }

  async branch(req: BranchRequest): Promise<void> {
    // git -C <workdir> checkout -b <branch> — purely local, no credential needed.
    // Pass an empty token; dockerRunArgs injects -e GIT_TOKEN but no git op here reads it.
    const gitArgs = ['-C', req.workdir, 'checkout', '-b', req.branch];
    const args = this.dockerRunArgs(req.volume, gitArgs);
    await runDocker(this.spawnFn, args, '', 'git branch', `repo: ${req.repo}, branch: ${req.branch}`);
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

  /**
   * Build the `docker run` argv for a lint/test check. Uses `--entrypoint sh` so the
   * shell command can do package-manager detection. No `-e GIT_TOKEN` — checks get no
   * credential (defense-in-depth on the boundary).
   */
  private dockerCheckArgs(volume: string, workdir: string, shellCmd: string): string[] {
    return [
      'run',
      '--rm',
      '-v', `${volume}:/workspace`,
      '-w', workdir,
      '--security-opt', 'no-new-privileges',
      '--entrypoint', 'sh',
      this.image,
      '-c', shellCmd,
    ];
  }

  async runCheck(req: CheckRequest): Promise<CheckResult> {
    // Resolution precedence:
    // 1. Per-repo override — checkCmds[repo][kind] if present and non-empty.
    // 2. Global override — lintCmd / testCmd (unchanged behavior).
    // 3. npm auto-detect (the only tier that can produce skipped: true).
    const perRepo = this.checkCmds.get(req.repo);
    const perRepoCmd = perRepo !== undefined
      ? (req.kind === 'lint' ? perRepo.lint : perRepo.test)
      : undefined;
    const globalCmd = req.kind === 'lint' ? this.lintCmd : this.testCmd;
    const override = perRepoCmd !== undefined ? perRepoCmd : globalCmd;

    // Auto-detect default: exit with the reserved skip code when there is nothing to
    // run (no package.json, or no matching npm script) so a skip is distinguishable
    // from a pass. `req.kind` is the closed 'lint' | 'test' union — safe to interpolate.
    const shellCmd = override !== undefined
      ? override
      : `if [ ! -f package.json ]; then echo "no package.json — skipping ${req.kind}"; exit ${CHECK_SKIP_EXIT}; fi; ` +
        `if node -e "var p=require('./package.json');process.exit(p.scripts&&p.scripts.${req.kind}?0:1)"; ` +
        `then npm run ${req.kind}; else echo "no ${req.kind} script — skipping"; exit ${CHECK_SKIP_EXIT}; fi`;

    const args = this.dockerCheckArgs(req.volume, req.workdir, shellCmd);
    const raw = await runDockerCapture(this.spawnFn, args, `check ${req.kind}`, `workdir: ${req.workdir}`);

    // A skip is only meaningful for the auto-detect default; an override always "ran".
    if (override === undefined && raw.exitCode === CHECK_SKIP_EXIT) {
      return { exitCode: 0, output: raw.output, skipped: true };
    }
    return { exitCode: raw.exitCode, output: raw.output, skipped: false };
  }
}
