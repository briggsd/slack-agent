/**
 * DockerRunner — spawns one `docker run -i` container per session.
 *
 * The container runs the runner image (Agent SDK + main.ts), speaks the
 * NDJSON protocol over stdio, and persists SDK session state on a named
 * Docker volume so it can resume after an idle-reap.
 *
 * Spawn is injectable for unit tests (default: child_process.spawn executing
 * the docker CLI).
 */

import { spawn as nodeSpawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import type { RunnerEvent, RunnerStream, SessionRunner, RunnerFactory, VolumeReaper } from './types.js';
import type { Profile } from '../profiles/registry.js';
import type {
  RunnerToGatewayMessage,
  GatewayToRunnerMessage,
} from './protocol.js';

// ── Config types ──────────────────────────────────────────────────────────────

export interface DockerRunnerConfig {
  /** Docker image for the runner container */
  image: string;
  /** Ready-handshake timeout in ms */
  readyTimeoutMs: number;
  /** Per-turn timeout in ms */
  turnTimeoutMs: number;
  /** Grace period before SIGKILL on dispose, in ms */
  killGraceMs: number;
  /** Container memory limit (e.g. "512m") */
  memory: string;
  /** Container CPU limit (e.g. "1.0") */
  cpus: string;
  /** PID limit */
  pidsLimit: number;
}

// ── Spawn seam ────────────────────────────────────────────────────────────────

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

// ── Sanitization helpers ──────────────────────────────────────────────────────

/** Make a session key safe for use in Docker container/volume names */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 64);
}

/** Canonical Docker volume name for a session's workspace. */
export function volumeNameFor(sessionKey: string): string {
  return `slackbot-ws-${sanitizeKey(sessionKey)}`;
}

/** Hard cap on a single `docker volume rm` so a wedged daemon can't stall the GC sweep. */
const VOLUME_RM_TIMEOUT_MS = 30_000;

// ── DockerRunner ──────────────────────────────────────────────────────────────

export class DockerRunner implements SessionRunner {
  private readonly child: ChildProcess;
  private readonly config: DockerRunnerConfig;
  private readonly escalation: { containerName: string; spawnFn: SpawnFn } | null;
  private disposed = false;

  /** Buffer for partial stdout data (NDJSON framing — may receive split chunks) */
  private stdoutBuf = '';

  /**
   * Completed lines buffered until consumed by nextLine().
   * Lines arrive via data events which may fire between awaits, so we
   * queue them rather than fan out to transient listeners.
   */
  private lineQueue: string[] = [];

  /** Single pending waiter for the next line (at most one at a time). */
  private lineWaiter: ((line: string | null) => void) | null = null;

  /** Set to true when the child exits; nextLine() returns null thereafter. */
  private childExited = false;

  constructor(
    child: ChildProcess,
    config: DockerRunnerConfig,
    escalation?: { containerName: string; spawnFn: SpawnFn },
  ) {
    this.child = child;
    this.config = config;
    this.escalation = escalation ?? null;

    // A broken pipe (container died mid-write) must not crash the gateway
    child.stdin?.on('error', () => {});

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line.trim() !== '') {
          this.deliverLine(line);
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      // Log runner stderr to gateway stderr — never to stdout
      process.stderr.write(
        typeof chunk === 'string' ? chunk : chunk.toString('utf-8'),
      );
    });

    const onExit = (): void => {
      this.childExited = true;
      if (this.lineWaiter !== null) {
        const w = this.lineWaiter;
        this.lineWaiter = null;
        w(null);
      }
    };
    child.once('exit', onExit);
    child.once('close', onExit);
  }

  private deliverLine(line: string): void {
    if (this.lineWaiter !== null) {
      const w = this.lineWaiter;
      this.lineWaiter = null;
      w(line);
    } else {
      this.lineQueue.push(line);
    }
  }

  /** Read the next line from stdout. Returns null when the process exits. */
  private nextLine(): Promise<string | null> {
    if (this.childExited && this.lineQueue.length === 0) {
      return Promise.resolve(null);
    }
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift() as string);
    }
    // No line yet — register a waiter
    return new Promise<string | null>((resolve) => {
      this.lineWaiter = resolve;
    });
  }

  /** Wait for the `ready` message from the runner, with timeout. */
  static async waitReady(
    runner: DockerRunner,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Runner did not become ready within ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const check = (): void => {
        runner.nextLine().then((line) => {
          if (settled) return;
          if (line === null) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('Runner exited before sending ready'));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Skip non-JSON lines, keep waiting
            check();
            return;
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as Record<string, unknown>)['type'] === 'ready'
          ) {
            settled = true;
            clearTimeout(timer);
            resolve();
          } else {
            // Not ready yet — keep reading
            check();
          }
        }).catch((err: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      };

      check();
    });
  }

  /** Race nextLine() against a deadline. Returns 'timeout' on timeout, null on process exit. */
  private nextLineWithTimeout(
    deadlineMs: number,
  ): Promise<string | null | 'timeout'> {
    if (this.childExited && this.lineQueue.length === 0) {
      return Promise.resolve(null);
    }
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift() as string);
    }

    return new Promise<string | null | 'timeout'>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Clear the waiter so it doesn't fire later
          if (this.lineWaiter === waiter) {
            this.lineWaiter = null;
          }
          resolve('timeout');
        }
      }, deadlineMs);

      const waiter = (line: string | null): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(line);
        }
      };

      this.lineWaiter = waiter;
    });
  }

  send(message: string): RunnerStream {
    const self = this;

    async function* gen(): RunnerStream {
        if (self.disposed) {
          yield { type: 'error', message: 'runner is disposed' } as RunnerEvent;
          return;
        }

        // Generate a simple correlation ID
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        const outMsg: GatewayToRunnerMessage = {
          type: 'user_message',
          id,
          text: message,
        };

        // Write the user_message line
        if (!self.child.stdin?.writable) {
          yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
          return;
        }
        self.child.stdin.write(JSON.stringify(outMsg) + '\n');

        // Read events until we get text or error for this id
        const { turnTimeoutMs } = self.config;
        const deadline = Date.now() + turnTimeoutMs;

        while (true) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            yield {
              type: 'error',
              message: `turn timed out after ${turnTimeoutMs}ms`,
            } as RunnerEvent;
            break;
          }

          const rawLine = await self.nextLineWithTimeout(remaining);

          if (rawLine === 'timeout') {
            yield {
              type: 'error',
              message: `turn timed out after ${turnTimeoutMs}ms`,
            } as RunnerEvent;
            break;
          }

          if (rawLine === null) {
            yield {
              type: 'error',
              message: 'runner process exited unexpectedly',
            } as RunnerEvent;
            break;
          }

          let parsed: RunnerToGatewayMessage;
          try {
            parsed = JSON.parse(rawLine) as RunnerToGatewayMessage;
          } catch {
            // Skip unparseable lines
            continue;
          }

          if (parsed.type === 'status' && parsed.id === id) {
            yield { type: 'status', text: parsed.text } as RunnerEvent;
          } else if (parsed.type === 'file' && parsed.id === id) {
            // Decode base64 → Buffer; malformed base64 → status, not crash
            let data: Buffer;
            try {
              data = Buffer.from(parsed.data_base64, 'base64');
            } catch {
              yield {
                type: 'status',
                text: `skipped file ${parsed.name}: base64 decode failed`,
              } as RunnerEvent;
              continue;
            }
            yield { type: 'file', name: parsed.name, data } as RunnerEvent;
          } else if (parsed.type === 'usage' && parsed.id === id) {
            yield {
              type: 'usage',
              costMicroUsd: parsed.costMicroUsd,
              inputTokens: parsed.inputTokens,
              outputTokens: parsed.outputTokens,
              cacheReadTokens: parsed.cacheReadTokens,
              cacheCreationTokens: parsed.cacheCreationTokens,
            } as RunnerEvent;
          } else if (parsed.type === 'text' && parsed.id === id) {
            yield { type: 'text', text: parsed.text } as RunnerEvent;
            break;
          } else if (parsed.type === 'error' && parsed.id === id) {
            yield { type: 'error', message: parsed.message } as RunnerEvent;
            break;
          }
          // Messages with different IDs ignored (shouldn't happen since turns are serial)
        }
    }
    return gen();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // End stdin gracefully
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }

    // Send SIGTERM
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }

    // After grace period, force-kill
    const graceMs = this.config.killGraceMs;
    await new Promise<void>((resolve) => {
      let done = false;

      const cleanup = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      this.child.once('exit', cleanup);
      this.child.once('close', cleanup);

      setTimeout(() => {
        if (!done) {
          // SIGKILL on the docker CLI client orphans the container — kill the
          // container itself by name, then the client.
          if (this.escalation !== null) {
            try {
              this.escalation.spawnFn('docker', ['kill', this.escalation.containerName], {
                stdio: 'ignore',
              });
            } catch {
              // ignore
            }
          }
          try {
            this.child.kill('SIGKILL');
          } catch {
            // ignore
          }
          cleanup();
        }
      }, graceMs);
    });
  }
}

// ── DockerRunnerFactory ───────────────────────────────────────────────────────

export class DockerRunnerFactory implements RunnerFactory, VolumeReaper {
  private readonly config: DockerRunnerConfig;
  private readonly spawnFn: SpawnFn;

  constructor(config: DockerRunnerConfig, spawnFn: SpawnFn = nodeSpawn) {
    this.config = config;
    this.spawnFn = spawnFn;
  }

  /** Remove the Docker volume backing `sessionKey`. Resolves true when the volume is
   *  gone (removed or already absent); false on any real failure. Never throws. */
  async removeVolumeForSession(sessionKey: string): Promise<boolean> {
    const volumeName = volumeNameFor(sessionKey);
    return new Promise<boolean>((resolve) => {
      let stderr = '';
      let settled = false;

      let child: ReturnType<SpawnFn>;
      try {
        child = this.spawnFn('docker', ['volume', 'rm', volumeName], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch {
        console.log(`[session] gc volume rm spawn error for ${volumeName}: spawn failed`);
        resolve(false);
        return;
      }

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });

      // Bound the call so a wedged `docker` can't hang the whole GC sweep (which awaits
      // each removal serially). On timeout, SIGKILL the child and resolve false — the row
      // is left for the next sweep.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(ok);
      };
      timer = setTimeout(() => {
        console.log(`[session] gc volume rm timed out for ${volumeName}`);
        try {
          child.kill('SIGKILL');
        } catch {
          /* best-effort — the process may already be gone */
        }
        settle(false);
      }, VOLUME_RM_TIMEOUT_MS);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }

      // `close` (not `exit`) fires after stdio is fully drained, so `stderr` is complete
      // when we inspect it for "No such volume" — `exit` can race that read.
      child.once('close', (code) => {
        if (code === 0) {
          console.log(`[session] gc volume removed: ${volumeName}`);
          settle(true);
        } else if (stderr.includes('No such volume')) {
          // Already gone — treat as success
          console.log(`[session] gc volume already absent: ${volumeName}`);
          settle(true);
        } else {
          console.log(`[session] gc volume rm failed for ${volumeName}: exit ${String(code)}`);
          settle(false);
        }
      });

      child.once('error', (err: Error) => {
        console.log(`[session] gc volume rm error for ${volumeName}: ${err.message}`);
        settle(false);
      });
    });
  }

  // profile is threaded through for future facets; currently ignored (M4 S02 seam only)
  async create(sessionKey: string, _profile: Profile): Promise<SessionRunner> {
    const safe = sanitizeKey(sessionKey);
    const containerName = `slackbot-${safe}`;
    const volumeName = volumeNameFor(sessionKey);

    const args: string[] = [
      'run',
      '--rm',
      '-i',
      '--name', containerName,
      '-v', `${volumeName}:/workspace`,
      '-e', 'ANTHROPIC_API_KEY',   // inherit from environment — never leak the value
      '--memory', this.config.memory,
      '--cpus', this.config.cpus,
      '--pids-limit', String(this.config.pidsLimit),
      '--security-opt', 'no-new-privileges',
      this.config.image,
    ];

    const child = this.spawnFn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const runner = new DockerRunner(child, this.config, {
      containerName,
      spawnFn: this.spawnFn,
    });

    await DockerRunner.waitReady(runner, this.config.readyTimeoutMs);

    return runner;
  }
}
