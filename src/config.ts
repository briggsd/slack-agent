function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

function optionalEnvString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' ? raw : defaultValue;
}

function optionalEnvMaybe(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' ? raw : undefined;
}

export type RunnerBackend = 'fake' | 'docker';

export interface DockerConfig {
  /** Docker image for the runner container */
  RUNNER_IMAGE: string;
  /** Time to wait for container `ready` handshake, ms */
  RUNNER_READY_TIMEOUT_MS: number;
  /** Per-turn timeout, ms */
  RUNNER_TURN_TIMEOUT_MS: number;
  /** Grace period before SIGKILL on dispose, ms */
  RUNNER_KILL_GRACE_MS: number;
  /** Container memory limit */
  RUNNER_MEMORY: string;
  /** Container CPU quota */
  RUNNER_CPUS: string;
  /** Container PID limit */
  RUNNER_PIDS_LIMIT: number;
}

/** Per-kind commands for a single repo. A missing kind falls through to the global override. */
export interface RepoCheckCmds {
  lint?: string;
  test?: string;
}

export interface OneShotConfig {
  /** Docker image used for the ephemeral credentialed git nodes (clone/push). */
  GIT_IMAGE: string;
  /** Per-host bot-account tokens. Absent host → that host is unavailable (lease throws). */
  githubToken: string | undefined;
  gitlabToken: string | undefined;
  /** Override shell command for the lint check (default: auto-detect via package.json). */
  lintCommand: string | undefined;
  /** Override shell command for the test check (default: auto-detect via package.json). */
  testCommand: string | undefined;
  /**
   * Per-repo command overrides parsed from ONESHOT_CHECK_CMDS (JSON). Takes precedence over
   * the global lintCommand/testCommand overrides. Empty map = no per-repo overrides.
   */
  checkCmds: ReadonlyMap<string, RepoCheckCmds>;
}

/**
 * Parse the ONESHOT_CHECK_CMDS environment variable into a typed map.
 *
 * Expected format: JSON object mapping repo slug → { lint?: string; test?: string }.
 * Any malformed input (undefined, empty string, invalid JSON, wrong shape) falls back to an
 * empty map — never throws, never crashes startup.
 *
 * Exported as a pure function so it can be unit-tested without mutating process.env.
 */
export function parseCheckCmds(raw: string | undefined): ReadonlyMap<string, RepoCheckCmds> {
  if (raw === undefined || raw === '') return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }

  const result = new Map<string, RepoCheckCmds>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry: RepoCheckCmds = {};
    const rec = value as Record<string, unknown>;
    if (typeof rec['lint'] === 'string' && rec['lint'] !== '') entry.lint = rec['lint'];
    if (typeof rec['test'] === 'string' && rec['test'] !== '') entry.test = rec['test'];
    // Skip entries with no effective command so `checkCmds.size > 0` stays a faithful
    // "has overrides" signal — the wiring sites gate on it. An all-invalid entry would
    // resolve identically (fall through to global/auto-detect), just with a misleading size.
    if (entry.lint !== undefined || entry.test !== undefined) result.set(key, entry);
  }
  return result;
}

export interface Config {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  IDLE_TIMEOUT_MS: number;
  /** Maximum time (ms) to wait for a human to approve the plan gate. Default: 15 min. */
  GATE_TIMEOUT_MS: number;
  RUNNER_BACKEND: RunnerBackend;
  /** Path to the SQLite session database. Parent dir is created on startup. */
  SESSION_DB_PATH: string;
  docker: DockerConfig;
  oneshot: OneShotConfig;
}

export function loadConfig(): Config {
  const backend = optionalEnvString('RUNNER_BACKEND', 'fake');
  if (backend !== 'fake' && backend !== 'docker') {
    throw new Error(
      `Invalid RUNNER_BACKEND "${backend}": must be "fake" or "docker"`,
    );
  }

  return {
    SLACK_BOT_TOKEN: requireEnv('SLACK_BOT_TOKEN'),
    SLACK_APP_TOKEN: requireEnv('SLACK_APP_TOKEN'),
    IDLE_TIMEOUT_MS: optionalEnvNumber('IDLE_TIMEOUT_MS', 10 * 60 * 1000),
    GATE_TIMEOUT_MS: optionalEnvNumber('GATE_TIMEOUT_MS', 15 * 60 * 1000),
    RUNNER_BACKEND: backend,
    SESSION_DB_PATH: optionalEnvString('SESSION_DB_PATH', '.data/sessions.db'),
    docker: {
      RUNNER_IMAGE: optionalEnvString('RUNNER_IMAGE', 'slackbot-runner:latest'),
      RUNNER_READY_TIMEOUT_MS: optionalEnvNumber('RUNNER_READY_TIMEOUT_MS', 30_000),
      RUNNER_TURN_TIMEOUT_MS: optionalEnvNumber('RUNNER_TURN_TIMEOUT_MS', 5 * 60_000),
      RUNNER_KILL_GRACE_MS: optionalEnvNumber('RUNNER_KILL_GRACE_MS', 5_000),
      RUNNER_MEMORY: optionalEnvString('RUNNER_MEMORY', '512m'),
      RUNNER_CPUS: optionalEnvString('RUNNER_CPUS', '1.0'),
      RUNNER_PIDS_LIMIT: optionalEnvNumber('RUNNER_PIDS_LIMIT', 256),
    },
    oneshot: {
      GIT_IMAGE: optionalEnvString('GIT_IMAGE', 'slackbot-runner:latest'),
      githubToken: optionalEnvMaybe('GITHUB_BOT_TOKEN'),
      gitlabToken: optionalEnvMaybe('GITLAB_BOT_TOKEN'),
      lintCommand: optionalEnvMaybe('ONESHOT_LINT_CMD'),
      testCommand: optionalEnvMaybe('ONESHOT_TEST_CMD'),
      checkCmds: parseCheckCmds(process.env['ONESHOT_CHECK_CMDS']),
    },
  };
}
