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

export interface Config {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  IDLE_TIMEOUT_MS: number;
  RUNNER_BACKEND: RunnerBackend;
  /** Path to the SQLite session database. Parent dir is created on startup. */
  SESSION_DB_PATH: string;
  docker: DockerConfig;
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
  };
}
