import { readFileSync } from 'node:fs';

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

function optionalEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  throw new Error(`Environment variable ${name} must be a boolean, got: ${raw}`);
}

export type RunnerBackend = 'fake' | 'docker';

export interface DockerConfig {
  /** Docker image for the runner container */
  RUNNER_IMAGE: string;
  /** Time to wait for container `ready` handshake, ms */
  RUNNER_READY_TIMEOUT_MS: number;
  /** Per-turn inactivity timeout, ms */
  RUNNER_TURN_TIMEOUT_MS: number;
  /** Absolute per-turn ceiling, ms — never reset within a turn */
  RUNNER_TURN_ABSOLUTE_TIMEOUT_MS: number;
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

const SELF_REPO = 'briggsd/slack-agent';
const REQUIRED_SELF_CHECK_CMD = 'npm run gate';

export type RuntimeArch = 'amd64' | 'arm64';

export interface RuntimeArchArtifact {
  url: string;       // https only
  sha256: string;    // 64 hex, stored lowercased
  binSubdir: string; // safe relative path (no '..', no leading '/')
}

export interface RuntimeCatalogEntry {
  version: string;
  format: 'tar.gz' | 'zip';
  /** At least one arch must be present. Keys constrained to RuntimeArch. */
  arch: { readonly [A in RuntimeArch]?: RuntimeArchArtifact };
}

export interface OneShotConfig {
  /** Docker image used for the ephemeral credentialed git nodes (clone/push). */
  GIT_IMAGE: string;
  /** Per-host bot-account tokens. Absent host → that host is unavailable (lease throws). */
  githubToken: string | undefined;
  gitlabToken: string | undefined;
  /**
   * Exact GitHub owner/name slugs the conversational clone_repo tool may clone.
   * Empty = deny all model-chosen clones.
   */
  cloneRepoAllowlist: ReadonlySet<string>;
  /** Override shell command for the lint check (default: auto-detect via package.json). */
  lintCommand: string | undefined;
  /** Override shell command for the test check (default: auto-detect via package.json). */
  testCommand: string | undefined;
  /**
   * Per-repo command overrides parsed from ONESHOT_CHECK_CMDS (JSON). Takes precedence over
   * the global lintCommand/testCommand overrides. Empty map = no per-repo overrides.
   */
  checkCmds: ReadonlyMap<string, RepoCheckCmds>;
  /**
   * Gateway-curated relocatable runtime catalog. Empty map = provision_runtime deny-all.
   */
  runtimeCatalog: ReadonlyMap<string, RuntimeCatalogEntry>;
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

function isSafeOwnerRepoSlug(repo: string): boolean {
  const segments = repo.split('/');
  if (segments.length !== 2) return false;
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      !/^[A-Za-z0-9._-]+$/.test(segment)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Parse EXEC_OPT_IN_USERS as a comma-separated list of TEAM:USER pairs.
 * Intentionally strict: an invalid entry fails startup so operators do not
 * accidentally believe a user was granted exec access when they were not.
 * De-duplicates repeated (team, user) pairs silently.
 */
export function parseExecOptInUsers(
  raw: string | undefined,
): ReadonlyArray<{ teamId: string; userId: string }> {
  if (raw === undefined || raw.trim() === '') return [];

  const seen = new Set<string>();
  const result: Array<{ teamId: string; userId: string }> = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (!/^[^\s:]+:[^\s:]+$/.test(entry)) {
      throw new Error(
        `Invalid EXEC_OPT_IN_USERS entry "${entry}": expected TEAM:USER (Slack team + user id)`,
      );
    }
    const colonIdx = entry.indexOf(':');
    const teamId = entry.slice(0, colonIdx);
    const userId = entry.slice(colonIdx + 1);
    const key = `${teamId}:${userId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ teamId, userId });
    }
  }
  return result;
}

/**
 * Parse CLONE_REPO_ALLOWLIST as a comma-separated list of exact owner/name slugs.
 * This is intentionally strict: an invalid entry fails startup so operators do not
 * accidentally believe a model-chosen repo was authorized when it was not.
 */
export function parseRepoAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') return new Set();

  const result = new Set<string>();
  for (const part of raw.split(',')) {
    const repo = part.trim();
    if (repo === '') continue;
    if (!isSafeOwnerRepoSlug(repo)) {
      throw new Error(`Invalid CLONE_REPO_ALLOWLIST entry "${repo}": expected owner/name`);
    }
    result.add(repo.toLowerCase());
  }
  return result;
}

export function assertDogfoodGate(
  allowlist: ReadonlySet<string>,
  checkCmds: ReadonlyMap<string, RepoCheckCmds>,
): void {
  if (!allowlist.has(SELF_REPO)) return;

  if (checkCmds.get(SELF_REPO)?.test === REQUIRED_SELF_CHECK_CMD) return;

  throw new Error(
    `${SELF_REPO} is in CLONE_REPO_ALLOWLIST, so its ONESHOT_CHECK_CMDS test command must be ${REQUIRED_SELF_CHECK_CMD}. See docs/DOGFOODING.md.`,
  );
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRuntimeName(value: string): boolean {
  // The catalog key is interpolated into /workspace/.runtimes/<name> (rm -rf + mv target),
  // so keep it a single safe path segment even though only operators write the catalog.
  return value !== '.' && value !== '..' && /^[a-zA-Z0-9._-]+$/.test(value);
}

function isSafeRuntimeBinSubdir(value: string): boolean {
  if (value === '' || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Parse a pinned runtime catalog JSON map.
 *
 * Malformed catalog entries fail startup rather than silently widening or weakening the
 * model-facing provision_runtime gate. An empty/absent catalog is represented by an empty map.
 */
export function parseRuntimeCatalog(raw: string | undefined): ReadonlyMap<string, RuntimeCatalogEntry> {
  if (raw === undefined || raw.trim() === '') return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid runtime catalog JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isRuntimeRecord(parsed)) {
    throw new Error('Invalid runtime catalog: expected a JSON object');
  }

  const VALID_ARCH_KEYS: ReadonlySet<string> = new Set(['amd64', 'arm64']);

  const result = new Map<string, RuntimeCatalogEntry>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!isSafeRuntimeName(name)) {
      throw new Error(`Invalid runtime catalog entry "${name}": name must be a safe path segment (letters, digits, ., _, -)`);
    }
    if (!isRuntimeRecord(value)) {
      throw new Error(`Invalid runtime catalog entry "${name}": expected an object`);
    }

    const version = value['version'];
    if (typeof version !== 'string' || version === '') {
      throw new Error(`Invalid runtime catalog entry "${name}": expected non-empty version string`);
    }

    const rawFormat = value['format'];
    let format: 'tar.gz' | 'zip';
    if (rawFormat === undefined) {
      format = 'tar.gz';
    } else if (rawFormat === 'tar.gz' || rawFormat === 'zip') {
      format = rawFormat;
    } else {
      throw new Error(`Invalid runtime catalog entry "${name}": format must be "tar.gz" or "zip"`);
    }

    const archRaw = value['arch'];
    if (!isRuntimeRecord(archRaw)) {
      throw new Error(`Invalid runtime catalog entry "${name}": arch must be an object`);
    }
    const archKeys = Object.keys(archRaw);
    if (archKeys.length === 0) {
      throw new Error(`Invalid runtime catalog entry "${name}": arch must define at least one arch`);
    }
    for (const archKey of archKeys) {
      if (!VALID_ARCH_KEYS.has(archKey)) {
        throw new Error(`Invalid runtime catalog entry "${name}": unknown arch key "${archKey}" (must be amd64 or arm64)`);
      }
    }

    const arch: { [A in RuntimeArch]?: RuntimeArchArtifact } = {};
    for (const archKey of archKeys) {
      const a = archKey as RuntimeArch;
      const artifactRaw = archRaw[archKey];
      if (!isRuntimeRecord(artifactRaw)) {
        throw new Error(`Invalid runtime catalog entry "${name}" arch "${a}": expected an object`);
      }
      const url = artifactRaw['url'];
      const sha256 = artifactRaw['sha256'];
      const binSubdir = artifactRaw['binSubdir'];
      if (typeof url !== 'string') {
        throw new Error(`Invalid runtime catalog entry "${name}" arch "${a}": expected url string`);
      }
      if (!url.startsWith('https://')) {
        throw new Error(`Invalid runtime catalog entry "${name}" arch "${a}": url must use https://`);
      }
      if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) {
        throw new Error(`Invalid runtime catalog entry "${name}" arch "${a}": sha256 must be 64 hex characters`);
      }
      if (typeof binSubdir !== 'string' || !isSafeRuntimeBinSubdir(binSubdir)) {
        throw new Error(`Invalid runtime catalog entry "${name}" arch "${a}": binSubdir must be a safe relative path`);
      }
      arch[a] = { url, sha256: sha256.toLowerCase(), binSubdir };
    }

    result.set(name, { version, format, arch });
  }
  return result;
}

function readRuntimeCatalog(path: string): ReadonlyMap<string, RuntimeCatalogEntry> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return new Map();
    }
    throw err;
  }
  return parseRuntimeCatalog(raw);
}

export interface SpendCapsConfig {
  /** Lifetime per-session cap, micro-USD. 0 = disabled. */
  perTaskMicroUsd: number;
  /** Rolling-24h per-user cap, micro-USD. 0 = disabled. */
  perUser24hMicroUsd: number;
  /** Rolling-24h workspace-wide cap, micro-USD. 0 = disabled. */
  perGlobal24hMicroUsd: number;
}

export interface Config {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  IDLE_TIMEOUT_MS: number;
  /** Longer timeout for idle conversational planning sessions. Default: 4 hours. */
  PLANNING_IDLE_TIMEOUT_MS: number;
  /** Maximum time (ms) to wait for a human to approve the plan gate. Default: 15 min. */
  GATE_TIMEOUT_MS: number;
  /** TTL for volume GC eligibility in ms. Default: 7 days. */
  VOLUME_TTL_MS: number;
  /** Interval for the volume GC sweep in ms. Default: 1 hour. */
  VOLUME_GC_INTERVAL_MS: number;
  RUNNER_BACKEND: RunnerBackend;
  /** Path to the SQLite session database. Parent dir is created on startup. */
  SESSION_DB_PATH: string;
  docker: DockerConfig;
  oneshot: OneShotConfig;
  spendCaps: SpendCapsConfig;
  decisionCapture: boolean;
  /** Users granted operator-level exec opt-in, reconciled into the store at startup. */
  execOptInUsers: ReadonlyArray<{ teamId: string; userId: string }>;
}

/** Convert a dollar amount to integer micro-USD, clamping negatives to 0. */
function usdToMicro(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

export function loadConfig(): Config {
  const backend = optionalEnvString('RUNNER_BACKEND', 'fake');
  if (backend !== 'fake' && backend !== 'docker') {
    throw new Error(
      `Invalid RUNNER_BACKEND "${backend}": must be "fake" or "docker"`,
    );
  }

  const cloneRepoAllowlist = parseRepoAllowlist(process.env['CLONE_REPO_ALLOWLIST']);
  const checkCmds = parseCheckCmds(process.env['ONESHOT_CHECK_CMDS']);
  assertDogfoodGate(cloneRepoAllowlist, checkCmds);
  const execOptInUsers = parseExecOptInUsers(process.env['EXEC_OPT_IN_USERS']);

  return {
    SLACK_BOT_TOKEN: requireEnv('SLACK_BOT_TOKEN'),
    SLACK_APP_TOKEN: requireEnv('SLACK_APP_TOKEN'),
    IDLE_TIMEOUT_MS: optionalEnvNumber('IDLE_TIMEOUT_MS', 10 * 60 * 1000),
    PLANNING_IDLE_TIMEOUT_MS: optionalEnvNumber('PLANNING_IDLE_TIMEOUT_MS', 4 * 60 * 60 * 1000),
    GATE_TIMEOUT_MS: optionalEnvNumber('GATE_TIMEOUT_MS', 15 * 60 * 1000),
    VOLUME_TTL_MS: optionalEnvNumber('VOLUME_TTL_MS', 7 * 24 * 60 * 60 * 1000),
    VOLUME_GC_INTERVAL_MS: optionalEnvNumber('VOLUME_GC_INTERVAL_MS', 60 * 60 * 1000),
    RUNNER_BACKEND: backend,
    SESSION_DB_PATH: optionalEnvString('SESSION_DB_PATH', '.data/sessions.db'),
    docker: {
      RUNNER_IMAGE: optionalEnvString('RUNNER_IMAGE', 'slackbot-runner:latest'),
      RUNNER_READY_TIMEOUT_MS: optionalEnvNumber('RUNNER_READY_TIMEOUT_MS', 30_000),
      RUNNER_TURN_TIMEOUT_MS: optionalEnvNumber('RUNNER_TURN_TIMEOUT_MS', 5 * 60_000),
      RUNNER_TURN_ABSOLUTE_TIMEOUT_MS: optionalEnvNumber('RUNNER_TURN_ABSOLUTE_TIMEOUT_MS', 30 * 60_000),
      RUNNER_KILL_GRACE_MS: optionalEnvNumber('RUNNER_KILL_GRACE_MS', 5_000),
      RUNNER_MEMORY: optionalEnvString('RUNNER_MEMORY', '512m'),
      RUNNER_CPUS: optionalEnvString('RUNNER_CPUS', '1.0'),
      RUNNER_PIDS_LIMIT: optionalEnvNumber('RUNNER_PIDS_LIMIT', 256),
    },
    oneshot: {
      GIT_IMAGE: optionalEnvString('GIT_IMAGE', 'slackbot-runner:latest'),
      githubToken: optionalEnvMaybe('GITHUB_BOT_TOKEN'),
      gitlabToken: optionalEnvMaybe('GITLAB_BOT_TOKEN'),
      cloneRepoAllowlist,
      lintCommand: optionalEnvMaybe('ONESHOT_LINT_CMD'),
      testCommand: optionalEnvMaybe('ONESHOT_TEST_CMD'),
      checkCmds,
      runtimeCatalog: readRuntimeCatalog(optionalEnvString('RUNTIME_CATALOG_PATH', 'config/runtimes.json')),
    },
    spendCaps: {
      perTaskMicroUsd:      usdToMicro(optionalEnvNumber('SPEND_CAP_PER_TASK_USD', 20)),
      perUser24hMicroUsd:   usdToMicro(optionalEnvNumber('SPEND_CAP_PER_USER_24H_USD', 100)),
      perGlobal24hMicroUsd: usdToMicro(optionalEnvNumber('SPEND_CAP_GLOBAL_24H_USD', 400)),
    },
    decisionCapture: optionalEnvBool('DECISION_CAPTURE', false),
    execOptInUsers,
  };
}
