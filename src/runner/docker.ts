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
  ErrorReason,
  RunnerEvent,
  RunnerSendOptions,
  RunnerStream,
  SessionRunner,
  RunnerFactory,
  VolumeReaper,
  BuildOutcome,
  ExecOutcome,
  GateResume,
} from './types.js';
import type { Profile } from '../profiles/registry.js';
import type {
  RunnerToGatewayMessage,
  GatewayToRunnerMessage,
  ApprovalVerdictMessage,
  ExecResultMessage,
} from './protocol.js';
import type { CloneService } from './clone-service.js';
import type { CloneOutcome } from './clone-service.js';
import type { PublishService } from './publish-service.js';
import type {
  PublishOutcome,
  PublishServiceRequest,
  PrEditOutcome,
  PrEditServiceRequest,
  PrCommentOutcome,
  PrCommentServiceRequest,
} from './publish-service.js';
import type { CheckService } from './check-service.js';
import type { CheckOutcome, CheckServiceRequest, RunChecksKind } from './check-service.js';
import type { RuntimeProvisionService } from './runtime-provision-service.js';
import type { ProvisionOutcome, RuntimeProvisionRequest } from './runtime-provision-service.js';

// ── Config types ──────────────────────────────────────────────────────────────

export interface DockerRunnerConfig {
  /** Docker image for the runner container */
  image: string;
  /** Clock seam for publish timing tests. Default: Date.now. */
  now?: () => number;
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
  private readonly now: () => number;
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
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;

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
    this.now = config.now ?? (() => Date.now());
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

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      this.exitCode = code;
      this.exitSignal = signal;
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

  private errorEvent(message: string, reason: ErrorReason): RunnerEvent {
    return { type: 'error', message, reason };
  }

  private async *serviceDispatch<TReq, TOutcome>(
    parsed: RunnerToGatewayMessage,
    spec: {
      /** e.g. 'request_pr_edit' — used only for the id-missing log line. */
      requestType: string;
      /** Validate the line and build the service DTO, or return null if malformed. */
      validate: (p: RunnerToGatewayMessage) => TReq | null;
      /** User-facing progress line, yielded before the service call. */
      statusText: (req: TReq) => string;
      /** Perform the privileged work. MUST itself return the unavailable outcome when the
       *  service (or volume) is not wired — availability is handled here, not by the helper. */
      invoke: (req: TReq) => Promise<TOutcome>;
      /** Build the *_result line for a completed outcome. */
      toResult: (id: string, outcome: TOutcome) => GatewayToRunnerMessage;
      /** Build the malformed-request fallback *_result line. */
      malformedResult: (id: string) => GatewayToRunnerMessage;
      /** Optional success event (pr_opened/pr_edited/pr_commented). elapsedMs is the
       *  measured service wall-clock; req is the validated request (so event fields that
       *  live on the request, e.g. repo, need no out-of-band capture). Return null for none. */
      toEvent?: (outcome: TOutcome, elapsedMs: number, req: TReq) => RunnerEvent | null;
    },
  ): AsyncGenerator<RunnerEvent, 'serviced' | 'skipped' | 'fatal', GateResume | BuildOutcome | ExecOutcome | undefined> {
    // Verdict contract: 'serviced' = the service ran and a result was written, so the caller
    // resets the turn deadline (real gateway-side work happened). 'skipped' = the line was
    // malformed or missing its id, so no work ran and the caller must NOT reset the deadline
    // — otherwise a container could keep its turn alive indefinitely by spamming bad lines.
    // 'fatal' = stdin is no longer writable, so the run must end.
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'string') {
      console.error(`[gateway] malformed ${spec.requestType}: missing id — skipping`);
      return 'skipped';
    }
    const req = spec.validate(parsed);
    if (req === null) {
      if (this.child.stdin?.writable) {
        this.child.stdin.write(JSON.stringify(spec.malformedResult(id)) + '\n');
      }
      return 'skipped';
    }
    yield { type: 'status', text: spec.statusText(req) } as RunnerEvent;
    const start = this.now();
    const outcome = await spec.invoke(req);
    const elapsedMs = this.now() - start;
    if (!this.child.stdin?.writable) {
      yield this.errorEvent('runner stdin is not writable', 'runner_error');
      return 'fatal';
    }
    this.child.stdin.write(JSON.stringify(spec.toResult(id, outcome)) + '\n');
    const event = spec.toEvent?.(outcome, elapsedMs, req);
    if (event !== null && event !== undefined) {
      yield event;
    }
    return 'serviced';
  }

  private unexpectedExitMessage(): string {
    return `runner process exited unexpectedly (code=${String(this.exitCode)}, signal=${String(this.exitSignal)})`;
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
          yield self.errorEvent('runner is disposed', 'runner_error');
          return;
        }

        // Generate a simple correlation ID
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // Write any trusted approval control first so the next user turn can consume it.
        if (!self.child.stdin?.writable) {
          yield self.errorEvent('runner stdin is not writable', 'runner_error');
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
            yield self.errorEvent(`turn timed out after ${turnTimeoutMs}ms`, 'timeout');
            break;
          }

          const rawLine = await self.nextLineWithTimeout(remaining);

          if (rawLine === 'timeout') {
            yield self.errorEvent(`turn timed out after ${turnTimeoutMs}ms`, 'timeout');
            break;
          }

          if (rawLine === null) {
            const runnerId = self.escalation?.containerName ?? 'unknown';
            console.error(
              `[runner] container exited unexpectedly for ${runnerId}: code=${String(self.exitCode)} signal=${String(self.exitSignal)}`,
            );
            yield self.errorEvent(self.unexpectedExitMessage(), 'container_exit');
            break;
          }

          let parsed: RunnerToGatewayMessage;
          try {
            parsed = JSON.parse(rawLine) as RunnerToGatewayMessage;
          } catch {
            yield { type: 'protocol_skip', reason: 'json_parse', bytes: Buffer.byteLength(rawLine, 'utf8') } as RunnerEvent;
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
          } else if (parsed.type === 'decision' && parsed.id === id) {
            if (
              parsed.point !== 'verify' ||
              (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') ||
              typeof parsed.rationale !== 'string' ||
              (parsed.correlationId !== undefined && typeof parsed.correlationId !== 'string')
            ) {
              yield { type: 'protocol_skip', reason: 'decision_invalid', bytes: Buffer.byteLength(rawLine, 'utf8') } as RunnerEvent;
              continue;
            }
            yield {
              type: 'decision',
              point: parsed.point,
              verdict: parsed.verdict,
              rationale: parsed.rationale,
              ...(parsed.correlationId !== undefined ? { correlationId: parsed.correlationId } : {}),
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
            const cloneVerdict = yield* self.serviceDispatch<{ repo: string }, CloneOutcome>(parsed, {
              requestType: 'request_clone',
              validate: (p) => {
                const u = p as { repo?: unknown };
                if (typeof u.repo !== 'string') return null;
                return { repo: u.repo };
              },
              statusText: (req) => `cloning ${req.repo}…`,
              invoke: (req) =>
                self.cloneService !== undefined && self.volume !== undefined
                  ? self.cloneService.clone({ repo: req.repo, volume: self.volume })
                  : Promise.resolve({ ok: false, error: 'clone unavailable' } as CloneOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'clone_result', id, ok: true, workdir: outcome.workdir }
                : { type: 'clone_result', id, ok: false, error: outcome.error },
              malformedResult: (id) => ({ type: 'clone_result', id, ok: false, error: 'malformed request' }),
            });
            if (cloneVerdict === 'fatal') return;
            if (cloneVerdict === 'skipped') continue;
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
              yield self.errorEvent('runner stdin is not writable', 'runner_error');
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
              yield self.errorEvent('runner stdin is not writable', 'runner_error');
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
            const publishCorrelationId = (parsed as { correlationId?: unknown }).correlationId;
            const publishVerdict = yield* self.serviceDispatch<PublishServiceRequest, PublishOutcome>(parsed, {
              requestType: 'request_publish',
              validate: (p) => {
                const u = p as { repo?: unknown; title?: unknown; body?: unknown; correlationId?: unknown };
                const t = u.title;
                const b = u.body;
                const c = u.correlationId;
                if (
                  typeof u.repo !== 'string' ||
                  (t !== undefined && typeof t !== 'string') ||
                  (b !== undefined && typeof b !== 'string') ||
                  (c !== undefined && typeof c !== 'string')
                ) return null;
                return {
                  repo: u.repo,
                  volume: self.volume ?? '',
                  ...(typeof t === 'string' ? { title: t } : {}),
                  ...(typeof b === 'string' ? { body: b } : {}),
                };
              },
              statusText: (req) => `publishing ${req.repo}…`,
              invoke: (req) =>
                self.publishService !== undefined && self.volume !== undefined
                  ? self.publishService.publish(req)
                  : Promise.resolve({ ok: false, reason: 'publish unavailable' } as PublishOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'publish_result', id, ok: true, prUrl: outcome.prUrl }
                : { type: 'publish_result', id, ok: false, reason: outcome.reason },
              malformedResult: (id) => ({ type: 'publish_result', id, ok: false, reason: 'malformed request' }),
              toEvent: (outcome, elapsedMs, req) => outcome.ok
                ? ({
                    type: 'pr_opened',
                    url: outcome.prUrl,
                    repo: req.repo,
                    number: outcome.prNumber,
                    headSha: outcome.headSha,
                    elapsedMs,
                    ...(typeof publishCorrelationId === 'string' ? { correlationId: publishCorrelationId } : {}),
                  } as RunnerEvent)
                : null,
            });
            if (publishVerdict === 'fatal') return;
            if (publishVerdict === 'skipped') continue;
            // Publishing is gateway-side work (lease + push + PR), not the agent's — give the
            // post-publish continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_pr_edit') {
            const editVerdict = yield* self.serviceDispatch<PrEditServiceRequest, PrEditOutcome>(parsed, {
              requestType: 'request_pr_edit',
              validate: (p) => {
                const u = p as { repo?: unknown; title?: unknown; body?: unknown };
                const t = u.title;
                const b = u.body;
                if (
                  typeof u.repo !== 'string' ||
                  (t !== undefined && typeof t !== 'string') ||
                  (b !== undefined && typeof b !== 'string')
                ) return null;
                return {
                  repo: u.repo,
                  volume: self.volume ?? '',
                  ...(typeof t === 'string' ? { title: t } : {}),
                  ...(typeof b === 'string' ? { body: b } : {}),
                };
              },
              statusText: (req) => `editing PR for ${req.repo}…`,
              invoke: (req) =>
                self.publishService !== undefined && self.volume !== undefined
                  ? self.publishService.editPr(req)
                  : Promise.resolve({ ok: false, reason: 'edit unavailable' } as PrEditOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'pr_edit_result', id, ok: true }
                : { type: 'pr_edit_result', id, ok: false, reason: outcome.reason },
              malformedResult: (id) => ({ type: 'pr_edit_result', id, ok: false, reason: 'malformed request' }),
              toEvent: (outcome, elapsedMs) => outcome.ok
                ? ({ type: 'pr_edited', url: outcome.prUrl, elapsedMs } as RunnerEvent)
                : null,
            });
            if (editVerdict === 'fatal') return;
            if (editVerdict === 'skipped') continue;
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_pr_comment') {
            const commentVerdict = yield* self.serviceDispatch<PrCommentServiceRequest, PrCommentOutcome>(parsed, {
              requestType: 'request_pr_comment',
              validate: (p) => {
                const u = p as { repo?: unknown; comment?: unknown };
                const c = u.comment;
                if (
                  typeof u.repo !== 'string' ||
                  typeof c !== 'string' ||
                  c.trim() === ''
                ) return null;
                return { repo: u.repo, volume: self.volume ?? '', comment: c };
              },
              statusText: (req) => `commenting on PR for ${req.repo}…`,
              invoke: (req) =>
                self.publishService !== undefined && self.volume !== undefined
                  ? self.publishService.commentPr(req)
                  : Promise.resolve({ ok: false, reason: 'comment unavailable' } as PrCommentOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'pr_comment_result', id, ok: true }
                : { type: 'pr_comment_result', id, ok: false, reason: outcome.reason },
              malformedResult: (id) => ({ type: 'pr_comment_result', id, ok: false, reason: 'malformed request' }),
              toEvent: (outcome, elapsedMs) => outcome.ok
                ? ({ type: 'pr_commented', url: outcome.prUrl, elapsedMs } as RunnerEvent)
                : null,
            });
            if (commentVerdict === 'fatal') return;
            if (commentVerdict === 'skipped') continue;
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_run_checks') {
            // The container requested deterministic checks for a verified local candidate.
            // Validate the line as data; service it inline via the no-credential gateway seam.
            const checksVerdict = yield* self.serviceDispatch<CheckServiceRequest, CheckOutcome>(parsed, {
              requestType: 'request_run_checks',
              validate: (p) => {
                const u = p as { repo?: unknown; kind?: unknown };
                const kind = u.kind;
                if (
                  typeof u.repo !== 'string' ||
                  !SAFE_OWNER_REPO_SLUG.test(u.repo) ||
                  (kind !== undefined && kind !== 'lint' && kind !== 'test' && kind !== 'all')
                ) return null;
                const checksKind: RunChecksKind = kind === undefined ? 'all' : kind;
                return { repo: u.repo, volume: self.volume ?? '', kind: checksKind };
              },
              statusText: (req) => `running checks for ${req.repo}...`,
              invoke: (req) =>
                self.checkService !== undefined && self.volume !== undefined
                  ? self.checkService.runChecks(req)
                  : Promise.resolve({ ok: false, reason: 'run_checks unavailable' } as CheckOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'run_checks_result', id, ok: true, results: outcome.results }
                : { type: 'run_checks_result', id, ok: false, reason: outcome.reason },
              malformedResult: (id) => ({ type: 'run_checks_result', id, ok: false, reason: 'malformed request' }),
            });
            if (checksVerdict === 'fatal') return;
            if (checksVerdict === 'skipped') continue;
            // Checks are gateway-side work (ephemeral check container), not the agent's — give
            // the post-check continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'request_provision') {
            // The container requested a pinned runtime be provisioned onto the session volume.
            // Validate as data; the catalog inside RuntimeProvisionService is the authorization gate.
            const provisionVerdict = yield* self.serviceDispatch<RuntimeProvisionRequest, ProvisionOutcome>(parsed, {
              requestType: 'request_provision',
              validate: (p) => {
                const u = p as { name?: unknown };
                if (typeof u.name !== 'string') return null;
                return { name: u.name, volume: self.volume ?? '' };
              },
              statusText: (req) => `provisioning runtime ${req.name}...`,
              invoke: (req) =>
                self.runtimeProvisionService !== undefined && self.volume !== undefined
                  ? self.runtimeProvisionService.provision(req)
                  : Promise.resolve({ ok: false, error: 'runtime provision unavailable' } as ProvisionOutcome),
              toResult: (id, outcome) => outcome.ok
                ? { type: 'provision_result', id, ok: true }
                : { type: 'provision_result', id, ok: false, error: outcome.error },
              malformedResult: (id) => ({ type: 'provision_result', id, ok: false, error: 'malformed request' }),
            });
            if (provisionVerdict === 'fatal') return;
            if (provisionVerdict === 'skipped') continue;
            // Provisioning is gateway-side work; give the post-provision continuation a fresh turn budget.
            deadline = Date.now() + turnTimeoutMs;
            continue;
          } else if (parsed.type === 'error' && parsed.id === id) {
            yield self.errorEvent(parsed.message, 'runner_error');
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
