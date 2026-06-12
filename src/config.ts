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

export interface Config {
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  IDLE_TIMEOUT_MS: number;
}

export function loadConfig(): Config {
  return {
    SLACK_BOT_TOKEN: requireEnv('SLACK_BOT_TOKEN'),
    SLACK_APP_TOKEN: requireEnv('SLACK_APP_TOKEN'),
    IDLE_TIMEOUT_MS: optionalEnvNumber('IDLE_TIMEOUT_MS', 10 * 60 * 1000),
  };
}
