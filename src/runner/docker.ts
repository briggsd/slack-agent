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
import type {
  ApprovalControl,
  RunnerEvent,
  RunnerSendOptions,
  RunnerStream,
  SessionRunner,
  RunnerFactory,
  VolumeReaper,
  BuildOutcome,
  ExecOutcome,
} from './types.js';
import type { Profile } from '../profiles/registry.js';
import type {
  RunnerToGatewayMessage,
  GatewayToRunnerMessage,
  ApprovalVerdictMessage,
  CloneResultMessage,
  RequestCloneMessage,
  RequestBuildMessage,
  ExecResultMessage,
  PublishResultMessage,
  RunChecksResultMessage,
  ProvisionResultMessage,
} from './protocol.js';
import type { CloneService } from './clone-service.js';
import type { CloneOutcome } from './clone-service.js';
import type { PublishService } from './publish-service.js';
import type { PublishOutcome, PublishServiceRequest } from './publish-service.js';
import type { CheckService } from './check-service.js';
import type { CheckOutcome, CheckServiceRequest, RunChecksKind } from './check-service.js';
import type { RuntimeProvisionService } from './runtime-provision-service.js';
import type { ProvisionOutcome, RuntimeProvisionRequest } from './runtime-provision-service.js';

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

// ── Trust-boundary coercion ───────────────────────────────────────────────────

/**
 * Cost/token fields come from the container — coerce each to a non-negative integer
 * (missing / non-finite / negative / non-number → 0) so neither the audit ledger nor
 * the Slice-B SUM cap can be skewed by a misreporting sandbox.
 */
function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

function approvalControlMessage(control: ApprovalControl): ApprovalVerdictMessage {
  return control.feedback !== undefined
    ? { type: 'approval_verdict', id: control.id, specRef: control.specRef, approved: control.approved, feedback: control.feedback }
    : { type: 'approval_verdict', id: control.id, specRef: control.specRef, approved: control.approved };
}

// ── Sanitization helpers ──────────────────────────────────────────────────────

/** Make a session key safe for use in Docker container/volume names */
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 64);
}

/** Canonical Docker volume name for a session's workspace. */
export function volumeNameFor(sessionKey: string): string {
  return `slackbot-ws-${sanitizeKey(sessionKey)}`;
}

/** Anti-poison ceiling on a single turn's recorded cost (micro-USD, ~$20). Far above any
 *  real turn; a value past it is a misreport, so we clamp rather than trust it. NOT a
 *  policy knob — the configurable caps live in the gateway. */
const PER_TURN_COST_CEILING_MICRO_USD = 20_000_000;

/** Hard cap on a single `docker volume rm` so a wedged daemon can't stall the GC sweep. */
const VOLUME_RM_TIMEOUT_MS = 30_000;

const SAFE_OWNER_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// ── DockerRunner ──────────────────────────────────────────────────────────────

export class DockerRunner implements SessionRunner {
  private readonly child: ChildProcess;
  private readonly config: DockerRunnerConfig;
  private readonly escalation: { containerName: string; spawnFn: SpawnFn } | null;
  private readonly cloneService?: CloneService;
  private readonly volume?: string;
  private readonly publishService?: PublishService;
  private readonly checkService?: CheckService;
  private readonly runtimeProvisionService?: RuntimeProvisionService;
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
    cloneService?: CloneService,
    volume?: string,
    publishService?: PublishService,
    checkService?: CheckService,
    runtimeProvisionService?: RuntimeProvisionService,
  ) {
    this.child = child;
    this.config = config;
    this.escalation = escalation ?? null;
    if (cloneService !== undefined) this.cloneService = cloneService;
    if (volume !== undefined) this.volume = volume;
    if (publishService !== undefined) this.publishService = publishService;
    if (checkService !== undefined) this.checkService = checkService;
    if (runtimeProvisionService !== undefined) this.runtimeProvisionService = runtimeProvisionService;

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

  send(message: string, opts?: RunnerSendOptions): RunnerStream {
    const self = this;

    async function* gen(): RunnerStream {
        if (self.disposed) {
          yield { type: 'error', message: 'runner is disposed' } as RunnerEvent;
          return;
        }

        // Generate a simple correlation ID
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // Write any trusted approval control first so the next user turn can consume it.
        if (!self.child.stdin?.writable) {
          yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
          return;
        }
        if (opts?.approval !== undefined) {
          self.child.stdin.write(JSON.stringify(approvalControlMessage(opts.approval)) + '\n');
        }
        const outMsg: GatewayToRunnerMessage = {
          type: 'user_message',
          id,
          text: message,
        };
        self.child.stdin.write(JSON.stringify(outMsg) + '\n');

        // Read events until we get text or error for this id
        const { turnTimeoutMs } = self.config;
        let deadline = Date.now() + turnTimeoutMs;

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
              costMicroUsd: Math.min(toCount(parsed.costMicroUsd), PER_TURN_COST_CEILING_MICRO_USD),
              inputTokens: toCount(parsed.inputTokens),
              outputTokens: toCount(parsed.outputTokens),
              cacheReadTokens: toCount(parsed.cacheReadTokens),
              cacheCreationTokens: toCount(parsed.cacheCreationTokens),
            } as RunnerEvent;
          } else if (parsed.type === 'text' && parsed.id === id) {
            yield { type: 'text', text: parsed.text } as RunnerEvent;
            break;
          } else if (parsed.type === 'request_approval') {
            // The container raised the build-spec human gate from inside the turn. This carries its
            // own approval id, distinct from the user-message turn id, and does not park the turn:
            // the manager stores it and routes a later authenticated reply back as a new-turn
            // approval control.
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_approval: missing id — skipping');
              continue;
            }
            if (typeof parsed.specRef !== 'string') {
              console.error('[gateway] malformed request_approval: missing specRef — skipping');
              continue;
            }
            yield { type: 'approval_requested', approvalId: parsed.id, prompt: parsed.specRef, specRef: parsed.specRef } as RunnerEvent;
            continue;
          } else if (parsed.type === 'request_clone') {
            // The container requested a credentialed clone (the credential never enters the agent env).
            // Validate the line as data; service it inline — no human hop. The clone is bounded by
            // the git node's own clone timeout (docker-git-node.ts), so this await cannot hang the
            // turn even though it sits outside the nextLineWithTimeout race.
            if (typeof parsed.id !== 'string') {
              // No usable id — can't correlate
              console.error('[gateway] malformed request_clone: missing id — skipping');
              continue;
            }
            const cloneId = parsed.id;
            if (typeof parsed.repo !== 'string') {
              // Have an id but malformed — unblock the parked tool
              const fallback: GatewayToRunnerMessage = {
                type: 'clone_result',
                id: cloneId,
                ok: false,
                error: 'malformed request',
              };
              if (self.child.stdin?.writable) {
                self.child.stdin.write(JSON.stringify(fallback) + '\n');
              }
              continue;
            }
            const cloneRepo = parsed.repo;
            // User-visible progress
            yield { type: 'status', text: `cloning ${cloneRepo}…` } as RunnerEvent;

            // Service the clone (or return unavailable if no service is wired)
            let cloneOutcome: CloneOutcome;
            if (self.cloneService !== undefined && self.volume !== undefined) {
              cloneOutcome = await self.cloneService.clone({ repo: cloneRepo, volume: self.volume });
            } else {
              cloneOutcome = { ok: false, error: 'clone unavailable' };
            }

            // Write the result back to the container
            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const cloneResult: GatewayToRunnerMessage = cloneOutcome.ok
              ? { type: 'clone_result', id: cloneId, ok: true, workdir: cloneOutcome.workdir }
              : { type: 'clone_result', id: cloneId, ok: false, error: cloneOutcome.error };
            self.child.stdin.write(JSON.stringify(cloneResult) + '\n');
            // The clone is gateway-side work (lease + ephemeral git container), not the agent's —
            // give the post-clone continuation a fresh turn budget rather than charging it the
            // clone's wall-clock, the same reasoning the approval branch resets `deadline`.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_build') {
            // The container's build_spec tool asked the gateway to run the build tail (S12a). Validate as
            // data; hand it to the manager via a run_build event and read back the BuildOutcome resume —
            // DockerRunner must NOT run the build itself (the manager/factory owns that).
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_build: missing id — skipping');
              continue;
            }
            const buildId = parsed.id;
            if (typeof parsed.repo !== 'string') {
              const fallback: GatewayToRunnerMessage = { type: 'build_result', id: buildId, ok: false, reason: 'malformed request' };
              if (self.child.stdin?.writable) self.child.stdin.write(JSON.stringify(fallback) + '\n');
              continue;
            }
            const buildRepo = parsed.repo;
            // Yield up to the manager (runBuild), which runs the tail and feeds back a BuildOutcome via next().
            const resume = yield { type: 'run_build', repo: buildRepo } as RunnerEvent;
            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const outcome = resume as BuildOutcome | undefined;   // the run_build yield only ever resumes with a BuildOutcome
            const buildResult: GatewayToRunnerMessage =
              outcome !== undefined && outcome.ok
                ? { type: 'build_result', id: buildId, ok: true }
                : { type: 'build_result', id: buildId, ok: false, reason: outcome !== undefined && !outcome.ok ? outcome.reason : 'build failed' };
            self.child.stdin.write(JSON.stringify(buildResult) + '\n');
            // The build is gateway-side work (a fresh container producing a local candidate), not the agent's — give the
            // post-build continuation a fresh turn budget, the same reasoning the approval/clone branches use.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_exec') {
            // The container's exec tool asked the gateway to run the ungated repo-oneshot
            // blueprint. Validate as data; authorization and execution are owned by the manager.
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_exec: missing id — skipping');
              continue;
            }
            const execId = parsed.id;
            if (
              (parsed.host !== 'github' && parsed.host !== 'gitlab') ||
              typeof parsed.repo !== 'string' ||
              typeof parsed.instruction !== 'string'
            ) {
              const fallback: GatewayToRunnerMessage = {
                type: 'exec_result',
                id: execId,
                ok: false,
                reason: 'malformed request',
              };
              if (self.child.stdin?.writable) self.child.stdin.write(JSON.stringify(fallback) + '\n');
              continue;
            }
            const resume = yield {
              type: 'run_exec',
              host: parsed.host,
              repo: parsed.repo,
              instruction: parsed.instruction,
            } as RunnerEvent;
            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const outcome = resume as ExecOutcome | undefined;
            const execResult: ExecResultMessage =
              outcome !== undefined && outcome.ok
                ? (outcome.prUrl !== undefined
                    ? { type: 'exec_result', id: execId, ok: true, prUrl: outcome.prUrl }
                    : { type: 'exec_result', id: execId, ok: true })
                : {
                    type: 'exec_result',
                    id: execId,
                    ok: false,
                    reason: outcome !== undefined && !outcome.ok ? outcome.reason : 'exec failed',
                  };
            self.child.stdin.write(JSON.stringify(execResult satisfies GatewayToRunnerMessage) + '\n');
            // Exec is gateway-side work, so give the post-exec continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_publish') {
            // The container requested publication of a verified local candidate. Validate the
            // line as data; service it inline via the credentialed gateway seam. The PR body and
            // title are passed as data to the service and must never be logged here.
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_publish: missing id — skipping');
              continue;
            }
            const publishId = parsed.id;
            const title = (parsed as { title?: unknown }).title;
            const body = (parsed as { body?: unknown }).body;
            if (
              typeof parsed.repo !== 'string' ||
              (title !== undefined && typeof title !== 'string') ||
              (body !== undefined && typeof body !== 'string')
            ) {
              const fallback: GatewayToRunnerMessage = {
                type: 'publish_result',
                id: publishId,
                ok: false,
                reason: 'malformed request',
              };
              if (self.child.stdin?.writable) {
                self.child.stdin.write(JSON.stringify(fallback) + '\n');
              }
              continue;
            }
            const publishReq: PublishServiceRequest = {
              repo: parsed.repo,
              volume: self.volume ?? '',
              ...(title !== undefined ? { title } : {}),
              ...(body !== undefined ? { body } : {}),
            };
            yield { type: 'status', text: `publishing ${publishReq.repo}…` } as RunnerEvent;

            let publishOutcome: PublishOutcome;
            if (self.publishService !== undefined && self.volume !== undefined) {
              publishOutcome = await self.publishService.publish(publishReq);
            } else {
              publishOutcome = { ok: false, reason: 'publish unavailable' };
            }

            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const publishResult: PublishResultMessage = publishOutcome.ok
              ? { type: 'publish_result', id: publishId, ok: true, prUrl: publishOutcome.prUrl }
              : { type: 'publish_result', id: publishId, ok: false, reason: publishOutcome.reason };
            self.child.stdin.write(JSON.stringify(publishResult satisfies GatewayToRunnerMessage) + '\n');
            if (publishOutcome.ok) {
              yield { type: 'pr_opened', url: publishOutcome.prUrl } as RunnerEvent;
            }
            // Publishing is gateway-side work (lease + push + PR), not the agent's — give the
            // post-publish continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_run_checks') {
            // The container requested deterministic checks for a verified local candidate.
            // Validate the line as data; service it inline via the no-credential gateway seam.
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_run_checks: missing id — skipping');
              continue;
            }
            const checksId = parsed.id;
            const kind = (parsed as { kind?: unknown }).kind;
            if (
              typeof parsed.repo !== 'string' ||
              !SAFE_OWNER_REPO_SLUG.test(parsed.repo) ||
              (kind !== undefined && kind !== 'lint' && kind !== 'test' && kind !== 'all')
            ) {
              const fallback: GatewayToRunnerMessage = {
                type: 'run_checks_result',
                id: checksId,
                ok: false,
                reason: 'malformed request',
              };
              if (self.child.stdin?.writable) {
                self.child.stdin.write(JSON.stringify(fallback) + '\n');
              }
              continue;
            }
            const checksKind: RunChecksKind = kind === undefined ? 'all' : kind;
            const checksReq: CheckServiceRequest = {
              repo: parsed.repo,
              volume: self.volume ?? '',
              kind: checksKind,
            };
            yield { type: 'status', text: `running checks for ${checksReq.repo}...` } as RunnerEvent;

            let checksOutcome: CheckOutcome;
            if (self.checkService !== undefined && self.volume !== undefined) {
              checksOutcome = await self.checkService.runChecks(checksReq);
            } else {
              checksOutcome = { ok: false, reason: 'run_checks unavailable' };
            }

            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const checksResult: RunChecksResultMessage = checksOutcome.ok
              ? { type: 'run_checks_result', id: checksId, ok: true, results: checksOutcome.results }
              : { type: 'run_checks_result', id: checksId, ok: false, reason: checksOutcome.reason };
            self.child.stdin.write(JSON.stringify(checksResult satisfies GatewayToRunnerMessage) + '\n');
            // Checks are gateway-side work (ephemeral check container), not the agent's — give
            // the post-check continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_provision') {
            // The container requested a pinned runtime be provisioned onto the session volume.
            // Validate as data; the catalog inside RuntimeProvisionService is the authorization gate.
            if (typeof parsed.id !== 'string') {
              console.error('[gateway] malformed request_provision: missing id — skipping');
              continue;
            }
            const provisionId = parsed.id;
            if (typeof parsed.name !== 'string') {
              const fallback: GatewayToRunnerMessage = {
                type: 'provision_result',
                id: provisionId,
                ok: false,
                error: 'malformed request',
              };
              if (self.child.stdin?.writable) {
                self.child.stdin.write(JSON.stringify(fallback) + '\n');
              }
              continue;
            }
            const provisionReq: RuntimeProvisionRequest = {
              name: parsed.name,
              volume: self.volume ?? '',
            };
            yield { type: 'status', text: `provisioning runtime ${provisionReq.name}...` } as RunnerEvent;

            let provisionOutcome: ProvisionOutcome;
            if (self.runtimeProvisionService !== undefined && self.volume !== undefined) {
              provisionOutcome = await self.runtimeProvisionService.provision(provisionReq);
            } else {
              provisionOutcome = { ok: false, error: 'runtime provision unavailable' };
            }

            if (!self.child.stdin?.writable) {
              yield { type: 'error', message: 'runner stdin is not writable' } as RunnerEvent;
              return;
            }
            const provisionResult: ProvisionResultMessage = provisionOutcome.ok
              ? { type: 'provision_result', id: provisionId, ok: true }
              : { type: 'provision_result', id: provisionId, ok: false, error: provisionOutcome.error };
            self.child.stdin.write(JSON.stringify(provisionResult satisfies GatewayToRunnerMessage) + '\n');
            // Provisioning is gateway-side work; give the post-provision continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
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
  private readonly cloneService?: CloneService;
  private readonly publishService?: PublishService;
  private readonly checkService?: CheckService;
  private readonly runtimeProvisionService?: RuntimeProvisionService;

  constructor(
    config: DockerRunnerConfig,
    spawnFn: SpawnFn = nodeSpawn,
    cloneService?: CloneService,
    publishService?: PublishService,
    checkService?: CheckService,
    runtimeProvisionService?: RuntimeProvisionService,
  ) {
    this.config = config;
    this.spawnFn = spawnFn;
    if (cloneService !== undefined) this.cloneService = cloneService;
    if (publishService !== undefined) this.publishService = publishService;
    if (checkService !== undefined) this.checkService = checkService;
    if (runtimeProvisionService !== undefined) this.runtimeProvisionService = runtimeProvisionService;
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
  async create(sessionKey: string, _profile: Profile, opts?: { nameSuffix?: string }): Promise<SessionRunner> {
    const safe = sanitizeKey(sessionKey);
    const suffix = opts?.nameSuffix !== undefined ? `-${opts.nameSuffix}` : '';
    const containerName = `slackbot-${safe}${suffix}`;
    const volumeName = volumeNameFor(sessionKey);   // UNCHANGED — shared volume

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
    }, this.cloneService, volumeName, this.publishService, this.checkService, this.runtimeProvisionService);

    await DockerRunner.waitReady(runner, this.config.readyTimeoutMs);

    return runner;
  }
}
