import type {
  ApprovalControl,
  ErrorReason,
  RunnerFactory,
  SessionRunner,
  RunnerStream,
  GateResume,
  VolumeReaper,
  BuildRunnerFactory,
  BuildOutcome,
  ExecOutcome,
  ExecInput,
} from '../runner/types.js';
import type { SlackClientLike, Placeholder } from '../slack/responder.js';
import { postPlaceholder, updatePlaceholder, boundSlackText, SLACK_INLINE_LIMIT, PREVIEW_LEN } from '../slack/responder.js';
import { getProfile, DEFAULT_PROFILE_ID } from '../profiles/registry.js';
import type { SessionStore, AuditEvent } from './store.js';
import { NoopSessionStore } from './store.js';
import type { SpendCapsConfig } from '../config.js';
import type { PrStateReader } from './pr-state-reader.js';

/**
 * The outcome of a `driveToThread` run — used by both the router drain path
 * (ignored) and `runBuild` (to translate into a `BuildOutcome`).
 */
type DriveOutcome =
  | { type: 'pr_opened'; url: string; repo: string; number: number; headSha: string; correlationId?: string }
  | { type: 'abandoned'; reason: string }
  | { type: 'error'; message: string; reason: ErrorReason }
  | { type: 'completed' };

/** Cap on an audit `summary` — metadata only, never a transcript (see {@link SessionManager.audit}). */
const AUDIT_SUMMARY_MAX_CHARS = 512;

/**
 * Cap on an audit `reasoning` — the opt-in decision-rationale path. Far larger than
 * `summary` (rationale is a deliberate prose trajectory, not metadata) but still bounded:
 * the value is container-originated free text, so a misbehaving/injected agent must not be
 * able to amplify unbounded writes into the ledger. Defense-in-depth at the write seam.
 */
const AUDIT_REASONING_MAX_CHARS = 8192;

export interface QueueItem {
  message: string;
  channel: string;
  threadTs: string;
  teamId?: string;
  userId?: string;
  profileId?: string;
  approval?: ApprovalControl;
}

type PendingApproval =
  | { kind: 'legacy'; resolve: (resume: GateResume) => void }
  | { kind: 'build_spec'; approvalId: string; prompt: string; specRef: string };

interface Session {
  key: string;
  runner: SessionRunner | null;
  profileId: string;
  channel: string;
  threadTs: string;
  queue: QueueItem[];
  /** true while the drain loop is processing a message */
  draining: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Slack user id of the original requestor (the mention that created the session).
   * Gate authz (M6 #22): only this user may resolve a parked plan gate. `undefined`
   * when the creating event carried no user — fail-closed, so nobody can resolve it.
   */
  requestorUserId: string | undefined;
  /**
   * Slack team id sourced from the creating mention (or from the stored row on the
   * rehydrate path). Carried on the session so audit events can tag the team without
   * needing the original QueueItem. `undefined` when the creating event had no team.
   */
  teamId: string | undefined;
  /** Gateway-side approval state. Legacy `await_approval` gates still store a resolver;
   *  build_spec stores an approval id/prompt so a later authenticated reply becomes a new turn. */
  pendingApproval: PendingApproval | null;
  /** Spawn latency to attribute to the next top-level timing row (cold start / rehydrate only). */
  pendingSpawnMs: number | null;
  /** Accumulates publish service time across a top-level turn, including nested build/exec runs. */
  turnPublishMs: number;
}

/** One rolling-window day in ms — the per-user/global cap window. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** All-zero caps (every cap disabled) — used as the default when callers don't supply caps. */
const DISABLED_CAPS: SpendCapsConfig = {
  perTaskMicroUsd: 0,
  perUser24hMicroUsd: 0,
  perGlobal24hMicroUsd: 0,
};
const DEFAULT_PENDING_APPROVAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PLANNING_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const BUILD_SPEC_APPROVE = new Set(['approve', 'approved']);
const BUILD_SPEC_REJECT = new Set(['cancel', 'abort', 'reject']);

/**
 * Extract safe, content-free structured metadata from a thrown error (and its `.cause`).
 * Never includes the error message body — only name, status, type, Slack error codes,
 * and the first stack frame.
 * Used in the gateway catch to produce diagnosable log output without echoing user content.
 */
export function gatewayErrorMeta(err: unknown): string {
  let name = err instanceof Error ? err.name : 'unknown';
  let status: number | undefined;
  let apiType: string | undefined;
  let slackErrCode: string | undefined;
  let slackDataErr: string | undefined;

  const candidates = [err, (err as { cause?: unknown })?.cause];
  for (const c of candidates) {
    if (c !== null && c !== undefined && typeof c === 'object') {
      const o = c as {
        name?: unknown;
        status?: unknown;
        type?: unknown;
        error?: { type?: unknown };
        code?: unknown;
        data?: { error?: unknown };
      };
      if (typeof o.name === 'string' && o.name !== '') name = o.name;
      if (status === undefined && typeof o.status === 'number') status = o.status;
      if (apiType === undefined) {
        if (typeof o.error?.type === 'string') apiType = o.error.type;
        else if (typeof o.type === 'string') apiType = o.type;
      }
      if (slackErrCode === undefined && typeof o.code === 'string') slackErrCode = o.code;
      if (slackDataErr === undefined && typeof o.data?.error === 'string') slackDataErr = o.data.error;
    }
  }

  const firstFrame =
    err instanceof Error && typeof err.stack === 'string'
      ? (err.stack.split('\n')[1]?.trim() ?? '')
      : '';

  const parts: string[] = [`name=${name}`];
  if (status !== undefined) parts.push(`status=${status}`);
  if (apiType !== undefined) parts.push(`type=${apiType}`);
  if (slackErrCode !== undefined) parts.push(`code=${slackErrCode}`);
  if (slackDataErr !== undefined) parts.push(`slackCode=${slackDataErr}`);
  if (firstFrame) parts.push(`@ ${firstFrame}`);
  return parts.join(' ');
}

/** True if the thrown error is Slack rejecting an over-length message. */
export function isSlackMsgTooLong(err: unknown): boolean {
  for (const c of [err, (err as { cause?: unknown })?.cause]) {
    if (c && typeof c === 'object') {
      const o = c as { data?: { error?: unknown } };
      if (o.data?.error === 'msg_too_long') return true;
    }
  }
  return false;
}

function classifyBuildSpecApprovalReply(approvalId: string, specRef: string, reply: string): ApprovalControl {
  const norm = reply.trim().toLowerCase();
  if (BUILD_SPEC_APPROVE.has(norm)) {
    return { id: approvalId, specRef, approved: true };
  }
  if (BUILD_SPEC_REJECT.has(norm)) {
    return { id: approvalId, specRef, approved: false };
  }
  return { id: approvalId, specRef, approved: false, feedback: reply };
}

function formatBuildSpecApprovalPrompt(prompt: string, assistantText?: string): string {
  const instruction =
    '_Reply `approve` to build this SPEC, `reject` or `cancel` to abort, or reply with any other text to request changes. The next requestor reply resumes this gate; very late replies may start a new turn instead._';
  return assistantText !== undefined
    ? `${prompt}\n\n${instruction}\n\n${assistantText}`
    : `${prompt}\n\n${instruction}`;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly idleTimeoutMs: number;
  private readonly planningIdleTimeoutMs: number;
  private readonly gateTimeoutMs: number;
  private readonly factory: RunnerFactory;
  private readonly slack: SlackClientLike;
  private readonly store: SessionStore;
  private readonly volumeReaper: VolumeReaper | undefined;
  private readonly volumeTtlMs: number;
  private readonly gcIntervalMs: number;
  private readonly prStateReader: PrStateReader | undefined;
  private readonly prStaleAfterMs: number;
  private readonly spendCaps: SpendCapsConfig;
  private readonly decisionCapture: boolean;
  private readonly now: () => number;
  private readonly buildRunnerFactory: BuildRunnerFactory | undefined;
  private readonly pendingApprovalRetentionMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private gcRunning = false;
  private prReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private prReconcileRunning = false;

  constructor(opts: {
    idleTimeoutMs: number;
    /** Longer timeout for idle conversational planning sessions. Default 4h. */
    planningIdleTimeoutMs?: number;
    /** How long a legacy `await_approval` gate waits for a reply before the
     *  fallback fires (the run resumes with a `timeout` resume). Default 15 min. */
    gateTimeoutMs?: number;
    factory: RunnerFactory;
    slack: SlackClientLike;
    store?: SessionStore;
    /** When provided, starts an unref'd GC interval that reaps volumes for idle sessions. */
    volumeReaper?: VolumeReaper;
    /** TTL for volume GC eligibility in ms (default 7 days). */
    volumeTtlMs?: number;
    /** Interval for the GC sweep in ms (default 1 hour). */
    gcIntervalMs?: number;
    /** When provided, starts an unref'd PR reconciliation interval on the GC cadence. */
    prStateReader?: PrStateReader;
    /** How long an open PR can sit before it is marked stale (default 30 days). */
    prStaleAfterMs?: number;
    /** Rolling dollar caps enforced at admission and pre-dispatch. All-zero = disabled (default). */
    spendCaps?: SpendCapsConfig;
    /** Persist structured verification rationale in audit_events when true. Default false. */
    decisionCapture?: boolean;
    /** Clock injectable for testable 24h windows. Default: () => Date.now(). */
    now?: () => number;
    /** Factory for build tail runners (DispatchingRunnerFactory). Required when the
     *  router emits `run_build`; a missing value is a programming error. */
    buildRunnerFactory?: BuildRunnerFactory;
    /** How long to keep a runner-reaped build_spec approval in memory for late replies. */
    pendingApprovalRetentionMs?: number;
  }) {
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.planningIdleTimeoutMs =
      opts.planningIdleTimeoutMs ?? DEFAULT_PLANNING_IDLE_TIMEOUT_MS;
    this.gateTimeoutMs = opts.gateTimeoutMs ?? 15 * 60 * 1000;
    this.factory = opts.factory;
    this.slack = opts.slack;
    this.store = opts.store ?? new NoopSessionStore();
    this.volumeReaper = opts.volumeReaper;
    this.volumeTtlMs = opts.volumeTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.gcIntervalMs = opts.gcIntervalMs ?? 60 * 60 * 1000;
    this.prStateReader = opts.prStateReader;
    this.prStaleAfterMs = opts.prStaleAfterMs ?? 30 * 24 * 60 * 60 * 1000;
    this.spendCaps = opts.spendCaps ?? DISABLED_CAPS;
    this.decisionCapture = opts.decisionCapture ?? false;
    this.now = opts.now ?? (() => Date.now());
    this.buildRunnerFactory = opts.buildRunnerFactory;
    this.pendingApprovalRetentionMs =
      opts.pendingApprovalRetentionMs ?? DEFAULT_PENDING_APPROVAL_RETENTION_MS;

    // Start the GC timer only when a reaper is provided.
    if (this.volumeReaper !== undefined) {
      const timer = setInterval(() => {
        void this.runVolumeGc();
      }, this.gcIntervalMs);
      // Allow the process to exit even if this timer is pending
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      this.gcTimer = timer;
    }

    if (this.prStateReader !== undefined) {
      const timer = setInterval(() => {
        void this.runPrReconciliation();
      }, this.gcIntervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      this.prReconcileTimer = timer;
    }
  }

  /**
   * Returns an existing session, or undefined if none exists.
   * Used for thread-reply routing (no auto-create).
   */
  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  /**
   * Returns an existing session or creates a new one (for app_mention).
   * profileId defaults to DEFAULT_PROFILE_ID when absent or unknown.
   *
   * `origin` tags the lifecycle audit event: a fresh mention is `'created'`, while the
   * rehydrate path (an evicted session being rebuilt from the store) is `'rehydrated'`,
   * so a rehydration does not inflate session-creation counts.
   */
  private async getOrCreate(
    key: string,
    item: QueueItem,
    origin: 'created' | 'rehydrated' = 'created',
  ): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      this.resetIdleTimer(existing);
      return existing;
    }
    const profileId = item.profileId;
    const profile = getProfile(profileId ?? DEFAULT_PROFILE_ID);
    const spawnStart = this.now();
    const runner = await this.factory.create(key, profile);
    const spawnMs = this.now() - spawnStart;
    const now = Date.now();
    const session: Session = {
      key,
      runner,
      profileId: profile.id,
      channel: item.channel,
      threadTs: item.threadTs,
      queue: [],
      draining: false,
      idleTimer: null,
      requestorUserId: item.userId,
      teamId: item.teamId,
      pendingApproval: null,
      pendingSpawnMs: spawnMs,
      turnPublishMs: 0,
    };
    this.sessions.set(key, session);
    this.resetIdleTimer(session);

    // Persist the new session row
    this.store.recordSession({
      session_key: key,
      team_id: item.teamId ?? null,
      user_id: item.userId ?? null,
      channel_id: item.channel,
      thread_ts: item.threadTs,
      profile_id: profile.id,
      harness_version: profile.version,
      created_at: now,
      last_active_at: now,
      status: 'active',
    });

    // Audit: session created / rehydrated (lifecycle event, metadata only).
    this.audit({
      session_key: key,
      team_id: item.teamId ?? null,
      user_id: item.userId ?? null,
      profile_id: profile.id,
      kind: 'lifecycle',
      tool: 'session',
      result: origin,
    });

    return session;
  }

  private async ensureRunner(session: Session): Promise<SessionRunner> {
    if (session.runner !== null) return session.runner;
    const profile = getProfile(session.profileId);
    const spawnStart = this.now();
    const runner = await this.factory.create(session.key, profile);
    session.pendingSpawnMs = this.now() - spawnStart;
    session.runner = runner;
    try {
      this.store.setStatus(session.key, 'active');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[session] store.setStatus(active) failed for ${session.key}: ${msg}`);
    }
    return runner;
  }

  /**
   * Check all configured spend caps for a session/user. Returns which cap was breached,
   * `'error'` if a SUM query threw, or `null` if all (enabled) caps pass.
   *
   * Fails CLOSED: a cost guardrail that can't verify spend must not let it run unbounded,
   * so any store error refuses the turn (the caller posts an honest "couldn't verify"
   * message). Disabled caps (0) never touch the store, so a deployment with caps off is
   * never affected by a DB error here.
   */
  private checkCaps(
    sessionKey: string,
    userId: string | undefined,
  ): 'task' | 'user' | 'global' | 'error' | null {
    const caps = this.spendCaps;
    try {
      if (caps.perTaskMicroUsd > 0 && this.store.sumCostByTask(sessionKey) >= caps.perTaskMicroUsd) {
        return 'task';
      }
      if (caps.perUser24hMicroUsd > 0 && userId !== undefined) {
        const since = this.now() - DAY_MS;
        if (this.store.sumCostByUserSince(userId, since) >= caps.perUser24hMicroUsd) return 'user';
      }
      if (caps.perGlobal24hMicroUsd > 0) {
        const since = this.now() - DAY_MS;
        if (this.store.sumCostGlobalSince(since) >= caps.perGlobal24hMicroUsd) return 'global';
      }
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[session] cap check failed for ${sessionKey} — failing closed: ${msg}`);
      return 'error';
    }
  }

  /**
   * Format micro-USD as a dollar string (e.g. "$20.00").
   */
  private static formatUsd(microUsd: number): string {
    return `$${(microUsd / 1e6).toFixed(2)}`;
  }

  /**
   * Build the honest budget-exceeded message for each cap type.
   * Never includes message content — only aggregate dollar amounts.
   */
  private capMessage(
    cap: 'task' | 'user' | 'global' | 'error',
    userId: string | undefined,
    sessionKey: string,
  ): string {
    const caps = this.spendCaps;
    if (cap === 'error') {
      // Fail-closed: a budget check that errored. Don't touch the store again (it just
      // threw) and don't quote a limit — this isn't a known breach.
      return `:no_entry_sign: Couldn't verify the spend budget right now — nothing was started. Please try again in a moment.`;
    }
    if (cap === 'task') {
      return `:no_entry_sign: This thread reached its budget (${SessionManager.formatUsd(caps.perTaskMicroUsd)}) — nothing was pushed. Start a new thread to continue.`;
    }
    if (cap === 'user') {
      let spent = 0;
      try {
        if (userId !== undefined) {
          const since = this.now() - DAY_MS;
          spent = this.store.sumCostByUserSince(userId, since);
        }
      } catch {
        // best-effort — omit the "you're at $X" detail if the query fails
      }
      return `:no_entry_sign: You've reached your daily spend limit (${SessionManager.formatUsd(caps.perUser24hMicroUsd)} / 24h; you're at ${SessionManager.formatUsd(spent)}). It frees up gradually as usage ages out — try again later.`;
    }
    // global
    void sessionKey; // referenced only for symmetry
    return `:no_entry_sign: The workspace daily spend limit (${SessionManager.formatUsd(caps.perGlobal24hMicroUsd)} / 24h) is reached — try again later.`;
  }

  /**
   * Post the honest budget message and record the enforcement action. Shared by the four
   * cap seams (three admission paths + the mid-task drain stop) so the post+audit shape
   * can't drift between them. `action` is 'rejected' (admission) or 'abandoned' (mid-task).
   * Metadata only — never message content.
   */
  private rejectForCap(
    cap: 'task' | 'user' | 'global' | 'error',
    action: 'rejected' | 'abandoned',
    ctx: {
      sessionKey: string;
      channel: string;
      threadTs: string;
      userId: string | undefined;
      teamId: string | undefined;
      profileId: string;
    },
  ): void {
    const text = this.capMessage(cap, ctx.userId, ctx.sessionKey);
    void this.slack
      .postMessage({ channel: ctx.channel, thread_ts: ctx.threadTs, text: boundSlackText(text) })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[session] failed to post cap notice for ${ctx.sessionKey}: ${msg}`);
      });
    this.audit({
      session_key: ctx.sessionKey,
      team_id: ctx.teamId ?? null,
      user_id: ctx.userId ?? null,
      profile_id: ctx.profileId,
      kind: 'correction',
      tool: 'spend-cap',
      result: `${action}:${cap}`,
    });
  }

  /**
   * Enqueue a message for a session, creating the session if needed (for mentions).
   */
  async enqueueNew(key: string, item: QueueItem): Promise<void> {
    // Admission cap check — before getOrCreate so no container spins up on a breach.
    const breachedCap = this.checkCaps(key, item.userId);
    if (breachedCap !== null) {
      this.rejectForCap(breachedCap, 'rejected', {
        sessionKey: key,
        channel: item.channel,
        threadTs: item.threadTs,
        userId: item.userId,
        teamId: item.teamId,
        profileId: getProfile(item.profileId ?? DEFAULT_PROFILE_ID).id,
      });
      return;
    }
    const session = await this.getOrCreate(key, item);
    session.queue.push(item);
    void this.drain(session);
  }

  /**
   * Enqueue a message into an existing in-memory session, or rehydrate from the
   * store when the session has been evicted (for thread replies).
   *
   * Returns false only when neither the in-memory map nor the store has a row
   * for this key (a truly-unknown thread). Returns true when the message was
   * accepted (in-memory hit or successful rehydration).
   */
  async enqueueExisting(key: string, item: QueueItem): Promise<boolean> {
    const session = this.sessions.get(key);
    if (session !== undefined) {
      // A run is awaiting a human approval reply. Legacy one-shot gates still resume the
      // parked generator; build_spec approvals turn the reply into a trusted control for
      // the next runner turn.
      //
      // SECURITY (M6 #22):
      // (1) Gate authorization — resolution is REQUESTOR-ONLY (M6 S04). Only the user who
      //     started the thread may approve/cancel/redirect a pending decision; this one check
      //     gates all three paths. Fail-closed: an unknown requestor (undefined) matches
      //     nobody, so no reply can resolve the pending decision.
      //     Invocation stays open by design — the real authority is downstream (every run
      //     ends at "open a PR", which a human reviews and merges; the bot never merges).
      // (2) Reply text is untrusted — HANDLED: the plan node folds gate feedback into the
      //     revised plan delimited-as-data + length-capped (<reviewer-feedback>), the same
      //     way the implement node treats check output. It is never passed as instructions.
      if (session.pendingApproval !== null) {
        const isRequestor =
          session.requestorUserId !== undefined &&
          item.userId === session.requestorUserId;
        if (!isRequestor) {
          // A bystander can't resolve someone else's run — and we don't enqueue it
          // either (the pending human decision owns the thread until it resolves).
          // Post a NEW threaded message (never an update() to the gate placeholder,
          // which must keep showing the plan + prompt for the requestor); ping the
          // requestor by name for accountability.
          console.log(`[session] gate reply from non-requestor ignored: ${session.key}`);

          // Audit: non-requestor tried to resolve the gate (metadata only — no reply text).
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: item.userId ?? null,
            profile_id: session.profileId,
            kind: 'approval',
            tool: session.pendingApproval.kind === 'build_spec' ? 'build_spec' : 'plan-gate',
            result: 'rejected_non_requestor',
          });

          const who =
            session.requestorUserId !== undefined
              ? `<@${session.requestorUserId}>`
              : 'the person who started this task';
          void this.slack
            .postMessage({
              channel: item.channel,
              thread_ts: item.threadTs,
              text: boundSlackText(`Only ${who} can approve or cancel this plan.`),
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `[session] failed to post non-requestor notice for ${session.key}: ${msg}`,
              );
            });
          return true;
        }
        this.resetIdleTimer(session);

        const pending = session.pendingApproval;
        if (pending.kind === 'legacy') {
          // Audit: requestor resolved the gate (metadata only — no reply text).
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'approval',
            tool: 'plan-gate',
            result: 'resolved',
          });
          pending.resolve({ kind: 'reply', text: item.message });
          return true;
        }

        const breachedApprovalResume = this.checkCaps(session.key, session.requestorUserId);
        if (breachedApprovalResume !== null) {
          this.rejectForCap(breachedApprovalResume, 'rejected', {
            sessionKey: session.key,
            channel: item.channel,
            threadTs: item.threadTs,
            userId: session.requestorUserId,
            teamId: session.teamId,
            profileId: session.profileId,
          });
          return true;
        }

        // Audit: requestor resolved the build_spec gate (metadata only — no reply text).
        this.audit({
          session_key: session.key,
          team_id: session.teamId ?? null,
          user_id: session.requestorUserId ?? null,
          profile_id: session.profileId,
          kind: 'approval',
          tool: 'build_spec',
          result: 'resolved',
        });
        session.pendingApproval = null;
        session.queue.push({
          ...item,
          approval: classifyBuildSpecApprovalReply(pending.approvalId, pending.specRef, item.message),
        });
        void this.drain(session);
        return true;
      }
      // Normal in-memory hit — admission cap check before enqueuing.
      const breachedInMem = this.checkCaps(session.key, session.requestorUserId);
      if (breachedInMem !== null) {
        this.rejectForCap(breachedInMem, 'rejected', {
          sessionKey: session.key,
          channel: item.channel,
          threadTs: item.threadTs,
          userId: session.requestorUserId,
          teamId: session.teamId,
          profileId: session.profileId,
        });
        return true; // message was handled; thread is known
      }
      this.resetIdleTimer(session);
      session.queue.push(item);
      void this.drain(session);
      return true;
    }

    // No in-memory session — check the store.
    const row = this.store.get(key);
    if (row === undefined) {
      // Truly-unknown thread: keep today's ignore behaviour.
      return false;
    }

    // Known thread, session was evicted (e.g. idle reap after gateway restart).
    // Admission cap check on the rehydrate path. Use the stored user_id (original requestor).
    const storedUserId = row.user_id ?? undefined;
    const breachedRehy = this.checkCaps(key, storedUserId);
    if (breachedRehy !== null) {
      this.rejectForCap(breachedRehy, 'rejected', {
        sessionKey: key,
        channel: item.channel,
        threadTs: item.threadTs,
        userId: storedUserId,
        teamId: row.team_id ?? undefined,
        profileId: row.profile_id,
      });
      return true; // message was handled; thread is known
    }

    // Rehydrate: recreate the runner from the stored profile_id.
    console.log(`[session] rehydrating evicted session: ${key}`);
    const rehydrated = await this.getOrCreate(key, {
      message: item.message,
      channel: item.channel,
      threadTs: item.threadTs,
      // Prefer stored profile so we honour what the session was originally created with.
      profileId: row.profile_id,
      // Source team_id from the stored row so audit events carry the correct team.
      ...(row.team_id !== null && { teamId: row.team_id }),
      // Source the requestor from the STORED row, not the replying message, so gate
      // authz (M6 #22) stays bound to the original starter. Omitted when null →
      // fail-closed (no one can resolve a rehydrated gate with no recorded requestor).
      ...(row.user_id !== null && { userId: row.user_id }),
    }, 'rehydrated');
    rehydrated.queue.push(item);
    void this.drain(rehydrated);
    return true;
  }

  private isPlanningSession(session: Session): boolean {
    return getProfile(session.profileId).mode === 'conversational';
  }

  private resetIdleTimer(session: Session, delayMs?: number): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    const usePlanningTimer = delayMs === undefined && this.isPlanningSession(session);
    const effectiveDelayMs =
      delayMs ?? (usePlanningTimer ? this.planningIdleTimeoutMs : this.idleTimeoutMs);
    const timer = setTimeout(() => {
      if (usePlanningTimer) {
        void this.expirePlanningSession(session.key);
      } else {
        void this.reapSession(session.key);
      }
    }, effectiveDelayMs);
    // Allow the process to exit even if this timer is pending
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
    session.idleTimer = timer;
  }

  private async expirePlanningSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) return;
    if (session.draining) {
      this.resetIdleTimer(session);
      return;
    }

    void this.slack
      .postMessage({
        channel: session.channel,
        thread_ts: session.threadTs,
        text: boundSlackText('Planning expired - mention me to resume.'),
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[session] failed to post planning expiry for ${key}: ${msg}`);
      });

    await this.reapSession(key, true);
  }

  private async reapSession(key: string, force = false): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) return;
    // Never reap mid-turn: a long-running turn would lose its runner. Try again later.
    if (!force && session.draining) {
      this.resetIdleTimer(session);
      return;
    }
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (!force && session.pendingApproval?.kind === 'build_spec') {
      if (session.runner !== null) {
        console.log(`[session] reaping runner for pending approval: ${key}`);
        await session.runner.dispose();
        session.runner = null;
        this.resetIdleTimer(session, this.pendingApprovalRetentionMs);
        return;
      }
    }
    this.sessions.delete(key);
    console.log(`[session] reaping idle session: ${key}`);
    this.store.setStatus(key, 'reaped');

    // Audit: session reaped (lifecycle event, metadata only).
    this.audit({
      session_key: key,
      team_id: session.teamId ?? null,
      user_id: session.requestorUserId ?? null,
      profile_id: session.profileId,
      kind: 'lifecycle',
      tool: 'session',
      result: 'reaped',
    });

    if (session.runner !== null) {
      await session.runner.dispose();
      session.runner = null;
    }
  }

  /**
   * Drive a runner stream to completion, handling all events and returning a
   * `DriveOutcome` that summarises the terminal state. Used by both the router
   * drain path (outcome ignored) and `runBuild` (outcome converted to a
   * `BuildOutcome`).
   */
  private async driveToThread(
    iterator: RunnerStream,
    placeholder: Placeholder | null,
    session: Session,
    item: QueueItem,
  ): Promise<DriveOutcome> {
    let captured: DriveOutcome = { type: 'completed' };
    // Helper: skip updatePlaceholder when no placeholder was posted (e.g. postPlaceholder failed).
    const tryUpdate = async (text: string): Promise<void> => {
      if (placeholder !== null) {
        await updatePlaceholder(this.slack, placeholder, text);
      }
    };
    // Post `text`; if it exceeds the inline limit, post a short preview and upload the
    // full text as a file so the content is never dropped. No-op when no placeholder.
    const tryUpdateOrFile = async (text: string, filename: string): Promise<void> => {
      if (placeholder === null) return;
      if (text.length <= SLACK_INLINE_LIMIT) {
        await updatePlaceholder(this.slack, placeholder, text);
        return;
      }
      const preview = text.slice(0, PREVIEW_LEN);
      await updatePlaceholder(
        this.slack,
        placeholder,
        `${preview}\n\n_…reply too long for Slack — full text attached as ${filename}._`,
      );
      try {
        await this.slack.uploadFile({
          channel: item.channel,
          thread_ts: item.threadTs,
          filename,
          data: Buffer.from(text, 'utf-8'),
        });
      } catch (uploadErr: unknown) {
        console.error(`[session] reply file upload failed in ${session.key}: ${gatewayErrorMeta(uploadErr)}`);
        // The preview is already posted; nothing more to do.
      }
    };
    try {
      let resume: GateResume | BuildOutcome | ExecOutcome | undefined;
      while (true) {
        const result = await iterator.next(resume);
        resume = undefined;
        if (result.done === true) break;
        const event = result.value;
        if (event.type === 'status') {
          if (session.pendingApproval?.kind === 'build_spec') {
            await tryUpdate(formatBuildSpecApprovalPrompt(session.pendingApproval.prompt, `_${event.text}_`));
          } else {
            await tryUpdate(`_${event.text}_`);
          }
        } else if (event.type === 'file') {
          try {
            await this.slack.uploadFile({
              channel: item.channel,
              thread_ts: item.threadTs,
              filename: event.name,
              data: event.data,
            });
          } catch (uploadErr: unknown) {
            const uploadMsg =
              uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
            console.error(
              `[session] file upload failed in ${session.key} (${event.name}): ${uploadMsg}`,
            );
            await tryUpdate(`:x: Failed to upload file ${event.name}: ${uploadMsg}`);
          }
        } else if (event.type === 'text') {
          if (session.pendingApproval?.kind === 'build_spec') {
            await tryUpdateOrFile(formatBuildSpecApprovalPrompt(session.pendingApproval.prompt, event.text), 'response.md');
          } else {
            await tryUpdateOrFile(event.text, 'response.md');
          }
        } else if (event.type === 'approval_requested') {
          session.pendingApproval = {
            kind: 'build_spec',
            approvalId: event.approvalId,
            prompt: event.prompt,
            specRef: event.specRef,
          };

          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'approval',
            tool: 'build_spec',
            result: 'requested',
          });

          await tryUpdate(formatBuildSpecApprovalPrompt(event.prompt));
        } else if (event.type === 'await_approval') {
          // Park: post the plan, wait for the next thread reply (or a timeout), and
          // feed the result back into the run on the next `next()`.
          resume = await this.awaitApproval(session, placeholder, event.prompt);
        } else if (event.type === 'run_build') {
          // Park: drive a fresh build tail runner and feed the BuildOutcome back.
          resume = await this.runBuild(session, item, event);
        } else if (event.type === 'run_exec') {
          // Park: authorize and drive an ungated repo-oneshot run, then feed the result back.
          resume = await this.runExec(session, item, event);
        } else if (event.type === 'abandoned') {
          // A gate deliberately ended the run (cancel/timeout). Post a clean, non-error
          // line and stop driving — the `finally` below calls iterator.return(), which
          // unwinds the run's own `finally` blocks (notably the orchestrator's lease
          // revoke). No downstream nodes (branch/push/open-pr) run.
          await tryUpdate(`:no_entry_sign: Plan abandoned (${event.reason}) — nothing was pushed.`);

          // Audit: abandoned (metadata only — reason is 'cancelled' or 'timed out').
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: event.reason === 'cancelled' ? 'correction' : 'approval',
            tool: 'plan-gate',
            result: event.reason === 'cancelled' ? 'cancelled' : 'timeout',
          });

          captured = { type: 'abandoned', reason: event.reason };
          break;
        } else if (event.type === 'pr_opened') {
          session.turnPublishMs += event.elapsedMs ?? 0;
          // Post the PR URL to Slack (same user-facing text as before the refactor).
          await tryUpdate(`Opened PR: ${event.url}`);

          // Audit: PR opened (action event; PR URL is metadata, not message content).
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'action',
            tool: 'open-pr',
            summary: event.url,
            result: 'opened',
          });

          // Best-effort: the PR is already open, so a metadata-write hiccup must not
          // flip a successful turn into an error. Swallow + log (session key only),
          // mirroring how audit() guards recordAudit.
          try {
            this.store.recordPullRequest({
              session_key: session.key,
              team_id: session.teamId ?? null,
              repo: event.repo,
              pr_number: event.number,
              head_sha: event.headSha,
              correlation_id: event.correlationId ?? null,
              profile_id: session.profileId,
              opened_at: this.now(),
            });
          } catch (prErr: unknown) {
            const msg = prErr instanceof Error ? prErr.message : String(prErr);
            console.error(`[session] store.recordPullRequest failed for ${session.key}: ${msg}`);
          }

          captured = {
            type: 'pr_opened',
            url: event.url,
            repo: event.repo,
            number: event.number,
            headSha: event.headSha,
            ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
          };
          // Don't break — let the loop drain to done
        } else if (event.type === 'pr_edited') {
          session.turnPublishMs += event.elapsedMs ?? 0;
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'action',
            tool: 'edit-pr',
            summary: event.url,
            result: 'edited',
          });
        } else if (event.type === 'pr_commented') {
          session.turnPublishMs += event.elapsedMs ?? 0;
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'action',
            tool: 'comment-pr',
            summary: event.url,
            result: 'commented',
          });
        } else if (event.type === 'usage') {
          // Slice A: record per-turn cost to the audit ledger. Measurement only — no
          // enforcement. Silent: no Slack post. Cost is metadata, never message content.
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'cost',
            tool: null,
            result: null,
            cost_tokens:
              event.inputTokens +
              event.outputTokens +
              event.cacheReadTokens +
              event.cacheCreationTokens,
            cost_micro_usd: event.costMicroUsd,
          });
        } else if (event.type === 'decision') {
          console.log(
            `[session] decision ${event.point} ${event.verdict} ${session.key}${event.correlationId !== undefined ? ` correlationId=${event.correlationId}` : ''}`,
          );
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'decision',
            tool: event.point,
            result: event.verdict,
            summary: event.correlationId ?? null,
            reasoning: this.decisionCapture ? event.rationale : null,
          });
        } else if (event.type === 'protocol_skip') {
          console.error(
            `[session] protocol skip (${event.reason}) ${session.key}: ${event.bytes}b`,
          );
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'protocol_skip',
            tool: null,
            result: event.reason,
            summary: `${event.bytes}b`,
          });
        } else if (event.type === 'error') {
          // The message is safe for gateway logs + the audit ledger only when the
          // gateway itself generated it (timeout duration; container exit code/signal).
          // A `runner_error` may be relayed verbatim from inside the container
          // (docker.ts forwards `parsed.message`), which is untrusted data and could
          // echo prompt/tool content — keep it on the Slack post (the user's own
          // thread) but never in logs or audit, per the never-log-message-content and
          // treat-container-output-as-data invariants. The typed `reason` + session
          // key remain the durable signal.
          const safeDetail = event.reason === 'runner_error' ? null : event.message;
          const safeClass = event.reason === 'runner_error' ? (event.errorClass ?? null) : null;
          const logSuffix = safeDetail !== null ? `: ${safeDetail}` : safeClass !== null ? `: ${safeClass}` : '';
          console.error(`[session] turn error (${event.reason}) ${session.key}${logSuffix}`);
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'error',
            tool: null,
            result: event.reason,
            summary: event.reason === 'runner_error' ? safeClass : safeDetail,
          });
          await tryUpdate(`:x: Error: ${event.message}`);
          captured = { type: 'error', message: event.message, reason: event.reason };
        }
      }
    } finally {
      // The manual drive loop doesn't auto-close the generator the way `for await`
      // does. Call return() on every exit (normal, error, abandonment) so the run's
      // own `finally` blocks run — notably the orchestrator revoking its credential
      // lease. A no-op on an already-completed generator.
      try {
        await iterator.return();
      } catch {
        // best-effort cleanup — must not mask the turn's real outcome
      }
    }
    return captured;
  }

  /**
   * Run a build tail for the given `run_build` event. Mirrors `awaitApproval`'s
   * shape but drives a fresh tail runner synchronously (no parking) and returns
   * the outcome as data for the coordinator to reason over.
   */
  private async runBuild(
    session: Session,
    item: QueueItem,
    event: { repo: string },
  ): Promise<BuildOutcome> {
    const buildFactory = this.buildRunnerFactory;
    if (buildFactory === undefined) {
      throw new Error(
        '[session] run_build fired but buildRunnerFactory is not configured — this is a programming error',
      );
    }
    const breachedCap = this.checkCaps(session.key, session.requestorUserId);
    if (breachedCap !== null) {
      this.rejectForCap(breachedCap, 'abandoned', {
        sessionKey: session.key,
        channel: item.channel,
        threadTs: item.threadTs,
        userId: session.requestorUserId,
        teamId: session.teamId,
        profileId: session.profileId,
      });
      return { ok: false, reason: 'spend budget reached before build' };
    }
    const placeholder = await postPlaceholder(this.slack, item.channel, item.threadTs);
    // createBuildRunner is INSIDE the try: spawning the tail container is fallible, and a
    // failure must come back to the coordinator as a `{ ok: false }` BuildOutcome (the whole
    // point — failures are data), not escape as an exception that orphans the placeholder and
    // aborts the router turn. `dispose` is guarded on whether a runner was actually created.
    let runner: SessionRunner | undefined;
    try {
      runner = await buildFactory.createBuildRunner(session.key, event.repo);
      const outcome = await this.driveToThread(runner.send(''), placeholder, session, item);
      if (outcome.type === 'error') return { ok: false, reason: outcome.message };
      if (outcome.type === 'abandoned') return { ok: false, reason: outcome.reason };
      return { ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      // Surface the failure on the build placeholder so it isn't stranded in 'thinking'.
      if (placeholder !== null) {
        try {
          await updatePlaceholder(this.slack, placeholder, `:x: Build failed to start: ${reason}`);
        } catch {
          // best effort — must not mask the real outcome
        }
      }
      return { ok: false, reason };
    } finally {
      if (runner !== undefined) await runner.dispose();   // dispose only if it was created
    }
  }

  private hasExecOptIn(teamId: string | undefined, userId: string | undefined): boolean {
    if (teamId === undefined || userId === undefined) {
      return false;
    }
    try {
      return this.store.hasExecOptIn(teamId, userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[session] exec opt-in lookup failed for ${teamId} — failing closed: ${msg}`);
      return false;
    }
  }

  /**
   * Run the ungated repo-oneshot blueprint only when the gateway has a recorded opt-in for
   * the user who authored the triggering turn — never the session's original requestor, so a
   * bystander can't piggyback on someone else's standing opt-in (mirrors the approval-gate
   * requestor check). Refusals are data for the coordinator, not thrown exceptions.
   */
  private async runExec(
    session: Session,
    item: QueueItem,
    event: ExecInput,
  ): Promise<ExecOutcome> {
    const input: ExecInput = {
      host: event.host,
      repo: event.repo,
      instruction: event.instruction,
    };
    const actor = item.userId;
    if (actor === undefined) {
      this.audit({
        session_key: session.key,
        team_id: session.teamId ?? null,
        user_id: null,
        profile_id: session.profileId,
        kind: 'correction',
        tool: 'exec',
        result: 'refused_no_requestor',
      });
      return { ok: false, reason: 'exec requires an opted-in requesting user' };
    }
    if (!this.hasExecOptIn(session.teamId, actor)) {
      this.audit({
        session_key: session.key,
        team_id: session.teamId ?? null,
        user_id: actor,
        profile_id: session.profileId,
        kind: 'correction',
        tool: 'exec',
        result: 'refused_no_opt_in',
      });
      return { ok: false, reason: 'exec requires an explicit recorded opt-in for the requesting user' };
    }

    const execFactory = this.buildRunnerFactory;
    if (execFactory === undefined) {
      throw new Error(
        '[session] run_exec fired but buildRunnerFactory is not configured — this is a programming error',
      );
    }

    this.audit({
      session_key: session.key,
      team_id: session.teamId ?? null,
      user_id: actor,
      profile_id: session.profileId,
      kind: 'action',
      tool: 'exec',
      result: 'started',
    });

    // Terminal audit so every 'started' exec reconciles to an end state. Metadata only:
    // the PR URL is gateway-controlled (matches the 'open-pr' convention); failure reasons
    // are deliberately NOT recorded here — they may carry runtime text, and this is an
    // action trail, never a transcript.
    const auditExecEnd = (result: string, summary: string | null = null): void => {
      this.audit({
        session_key: session.key,
        team_id: session.teamId ?? null,
        user_id: actor,
        profile_id: session.profileId,
        kind: 'action',
        tool: 'exec',
        result,
        summary,
      });
    };
    // postPlaceholder runs inside the try so a Slack failure still terminalizes the
    // 'started' row via auditExecEnd('failed') rather than leaving it dangling.
    let placeholder: Placeholder | null = null;
    let runner: SessionRunner | undefined;
    try {
      placeholder = await postPlaceholder(this.slack, item.channel, item.threadTs);
      runner = await execFactory.createExecRunner(session.key, input);
      const outcome = await this.driveToThread(runner.send(''), placeholder, session, item);
      if (outcome.type === 'pr_opened') {
        auditExecEnd('succeeded_pr', outcome.url);
        return { ok: true, prUrl: outcome.url };
      }
      if (outcome.type === 'error') {
        auditExecEnd('failed');
        return { ok: false, reason: outcome.message };
      }
      if (outcome.type === 'abandoned') {
        auditExecEnd('abandoned');
        return { ok: false, reason: outcome.reason };
      }
      auditExecEnd('succeeded');
      return { ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      auditExecEnd('failed');
      if (placeholder !== null) {
        try {
          await updatePlaceholder(this.slack, placeholder, `:x: Exec failed to start: ${reason}`);
        } catch {
          // best effort — must not mask the real outcome
        }
      }
      return { ok: false, reason };
    } finally {
      if (runner !== undefined) await runner.dispose();
    }
  }

  private async drain(session: Session): Promise<void> {
    if (session.draining) return;
    session.draining = true;

    while (session.queue.length > 0) {
      const item = session.queue.shift();
      if (item === undefined) break;

      // Pre-dispatch cap check (mid-task graceful stop). The prior turn already
      // completed and its cost is in the ledger. If accumulated spend ≥ any cap,
      // refuse to start the next turn — post a message, clear the queue, and break.
      const breachedMid = this.checkCaps(session.key, session.requestorUserId);
      if (breachedMid !== null) {
        this.rejectForCap(breachedMid, 'abandoned', {
          sessionKey: session.key,
          channel: item.channel,
          threadTs: item.threadTs,
          userId: session.requestorUserId,
          teamId: session.teamId,
          profileId: session.profileId,
        });
        session.queue.length = 0; // drop any further queued turns
        break;
      }

      // Reset idle timer each time we start processing a message
      this.resetIdleTimer(session);
      // Bump last_active_at on each turn. A store hiccup must not abort the drain loop.
      try {
        this.store.touch(session.key, Date.now());
      } catch (touchErr: unknown) {
        const touchMsg = touchErr instanceof Error ? touchErr.message : String(touchErr);
        console.error(`[session] store.touch failed for ${session.key}: ${touchMsg}`);
      }

      let placeholder: Placeholder | null = null;
      try {
        placeholder = await postPlaceholder(
          this.slack,
          item.channel,
          item.threadTs,
        );
        const runner = await this.ensureRunner(session);
        session.turnPublishMs = 0;
        // Capture + clear the pending spawn cost up front so it attaches to exactly
        // this turn and can never leak onto a later turn if this one errors before the
        // timing row is written.
        const spawnMsForTurn = session.pendingSpawnMs;
        session.pendingSpawnMs = null;

        // Drive the run manually via driveToThread. The router turn ignores the
        // return value — it's only used when runBuild calls driveToThread for the tail.
        const iterator = runner.send(
          item.message,
          item.approval !== undefined ? { approval: item.approval } : undefined,
        );
        const turnStart = this.now();
        try {
          await this.driveToThread(iterator, placeholder, session, item);
        } finally {
          // Record per-turn latency for every driven turn — including errored/timed-out
          // ones, where latency is most worth seeing. Best-effort like every audit row.
          const agentMs = this.now() - turnStart;
          this.audit({
            session_key: session.key,
            team_id: session.teamId ?? null,
            user_id: session.requestorUserId ?? null,
            profile_id: session.profileId,
            kind: 'timing',
            tool: null,
            result: null,
            durations_ms: JSON.stringify({
              agentMs,
              ...(spawnMsForTurn !== null ? { spawnMs: spawnMsForTurn } : {}),
              ...(session.turnPublishMs > 0 ? { publishMs: session.turnPublishMs } : {}),
            }),
          });
          session.turnPublishMs = 0;
        }
      } catch (err: unknown) {
        const meta = gatewayErrorMeta(err);
        console.error(`[session] error processing message in ${session.key}: ${meta}`);
        if (placeholder !== null) {
          try {
            const userMsg = isSlackMsgTooLong(err)
              ? ':x: That response was too long to post in Slack — try a narrower question.'
              : `:x: Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
            await updatePlaceholder(this.slack, placeholder, userMsg);
          } catch {
            // best effort
          }
        }
      }
    }

    session.draining = false;
    // Reset idle timer after drain completes (session went idle)
    this.resetIdleTimer(session);
  }

  /**
   * Park a run at an approval gate: post the plan, then resolve with the next thread
   * reply (routed here by {@link enqueueExisting}) or a `timeout` after `gateTimeoutMs`.
   * Exactly one of reply/timeout settles it; the other is cancelled. The session stays
   * `draining` throughout, so the idle-reaper backs off and the run holds its container
   * until resolved (in-memory only — a gateway restart mid-park loses the parked run).
   */
  private awaitApproval(
    session: Session,
    placeholder: Placeholder | null,
    prompt: string,
  ): Promise<GateResume> {
    const minutes = Math.max(1, Math.round(this.gateTimeoutMs / 60000));
    // Fail-closed diagnostic: with no recorded requestor, the gate-authz check in
    // enqueueExisting rejects every reply, so only the timeout can ever resolve this.
    if (session.requestorUserId === undefined) {
      console.log(
        `[session] gate parked with no requestor — only a timeout can resolve it: ${session.key}`,
      );
    }
    // Audit: gate parked (approval requested, metadata only — no plan text).
    this.audit({
      session_key: session.key,
      team_id: session.teamId ?? null,
      user_id: session.requestorUserId ?? null,
      profile_id: session.profileId,
      kind: 'approval',
      tool: 'plan-gate',
      result: 'requested',
    });

    // Register the parked state SYNCHRONOUSLY (the Promise executor runs now), before
    // any await — so a reply that arrives while the prompt is still being posted is
    // routed to the gate by enqueueExisting, not enqueued as a brand-new turn.
    const result = new Promise<GateResume>((resolve) => {
      const settle = (resume: GateResume): void => {
        if (session.pendingApproval?.kind !== 'legacy') return; // already settled by the other path
        clearTimeout(timer);
        session.pendingApproval = null;
        resolve(resume);
      };
      const timer = setTimeout(() => settle({ kind: 'timeout' }), this.gateTimeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      session.pendingApproval = { kind: 'legacy', resolve: settle };
    });
    // Post the plan + how to respond AFTER parking is registered. Wording is neutral
    // about the outcome: the framework only feeds a `timeout` resume back into the run;
    // whether that abandons is the gate node's decision (the supervised one-shot node
    // aborts on timeout — design/0006). Fire-and-forget so a post failure can't strand
    // the parked run; the timeout still bounds it.
    if (placeholder !== null) {
      // The gate node's `prompt` already carries the response vocabulary (approve/cancel/
      // changes); the manager only adds the timeout note, since it owns the timer.
      void updatePlaceholder(
        this.slack,
        placeholder,
        `${prompt}\n\n_No reply within ${minutes} min → the plan is abandoned._`,
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[session] failed to post approval prompt for ${session.key}: ${msg}`);
      });
    }
    return result;
  }

  /**
   * Best-effort audit write. Fills `ts` = Date.now() and wraps in a try/catch so a
   * store error is logged and swallowed — never aborts the turn. Fields not supplied
   * default to null (summary, reasoning, cost_tokens are a later slice).
   *
   * `summary` is length-capped as defense-in-depth: this is an action/cost trail, never
   * a transcript, and the values passed today are short gateway metadata such as PR URLs
   * and build correlation ids. The cap bounds blast radius if a future caller is careless —
   * it does not license putting message content here. `reasoning` remains null by default
   * and is used only for opt-in decision rationale capture.
   */
  private audit(partial: Omit<AuditEvent, 'ts' | 'summary' | 'reasoning' | 'cost_tokens' | 'cost_micro_usd' | 'durations_ms' | 'graded_audit_id'> & {
    summary?: string | null;
    reasoning?: string | null;
    cost_tokens?: number | null;
    cost_micro_usd?: number | null;
    durations_ms?: string | null;
    graded_audit_id?: number | null;
  }): void {
    const summary =
      typeof partial.summary === 'string'
        ? partial.summary.slice(0, AUDIT_SUMMARY_MAX_CHARS)
        : partial.summary ?? null;
    const reasoning =
      typeof partial.reasoning === 'string'
        ? partial.reasoning.slice(0, AUDIT_REASONING_MAX_CHARS)
        : partial.reasoning ?? null;
    const event: AuditEvent = {
      ...partial,
      ts: Date.now(),
      summary,
      reasoning,
      cost_tokens: partial.cost_tokens ?? null,
      cost_micro_usd: partial.cost_micro_usd ?? null,
      durations_ms: partial.durations_ms ?? null,
      graded_audit_id: partial.graded_audit_id ?? null,
    };
    try {
      this.store.recordAudit(event);
    } catch (auditErr: unknown) {
      const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
      console.error(`[session] store.recordAudit failed for ${partial.session_key}: ${msg}`);
    }
  }

  /** Sweep for volumes whose sessions have been idle past `volumeTtlMs`. Best-effort:
   *  a single row's failure never aborts the loop. Skips live in-memory sessions.
   *  The GC interval calls this; also invoked directly by tests for determinism. */
  async runVolumeGc(): Promise<void> {
    if (this.gcRunning) return;
    this.gcRunning = true;
    try {
      const cutoff = Date.now() - this.volumeTtlMs;
      const rows = this.store.listExpired(cutoff);
      for (const row of rows) {
        // Skip any session that still has a live in-memory entry (container in use).
        if (this.sessions.has(row.session_key)) continue;
        try {
          // volumeReaper is always defined when runVolumeGc is called (the interval is
          // only started when volumeReaper !== undefined), but the type is optional so
          // we guard for the compiler.
          const reaper = this.volumeReaper;
          if (reaper === undefined) continue;
          const ok = await reaper.removeVolumeForSession(row.session_key);
          // Re-check liveness AFTER the await: a reply could have recreated the session
          // (and a fresh container/volume) while the rm was in flight. If so, leave its
          // row alone rather than deleting a now-live session's index entry (TOCTOU).
          if (ok && !this.sessions.has(row.session_key)) {
            this.store.deleteSession(row.session_key);
            console.log(`[session] gc removed volume + row: ${row.session_key}`);
          } else if (ok) {
            console.log(`[session] gc skipped row delete — session re-created mid-sweep: ${row.session_key}`);
          } else {
            console.log(`[session] gc volume rm failed, will retry next sweep: ${row.session_key}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[session] gc error for ${row.session_key}: ${msg}`);
        }
      }
    } finally {
      this.gcRunning = false;
    }
  }

  async runPrReconciliation(): Promise<void> {
    if (this.prReconcileRunning) return;
    this.prReconcileRunning = true;
    try {
      const reader = this.prStateReader;
      if (reader === undefined) return;

      const rows = this.store.listOpenPullRequests();
      for (const row of rows) {
        try {
          const polledAt = this.now();
          if (polledAt - row.opened_at > this.prStaleAfterMs) {
            this.store.resolvePullRequest(row.id, 'stale', polledAt);
            continue;
          }

          const st = await reader.getState({ repo: row.repo, number: row.pr_number });
          const settledAt = this.now();
          if (st.status === 'merged') {
            this.store.resolvePullRequest(
              row.id,
              st.headSha === row.head_sha ? 'merged_clean' : 'merged_intervened',
              settledAt,
            );
          } else if (st.status === 'closed') {
            this.store.resolvePullRequest(row.id, 'closed', settledAt);
          } else {
            this.store.touchPullRequestPolled(row.id, settledAt);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[session] pr reconcile error for ${row.repo}#${row.pr_number}: ${msg}`);
        }
      }
    } finally {
      this.prReconcileRunning = false;
    }
  }

  /** Stop the GC interval (called from disposeAll on clean shutdown). */
  stopVolumeGc(): void {
    if (this.gcTimer !== null) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  stopPrReconciliation(): void {
    if (this.prReconcileTimer !== null) {
      clearInterval(this.prReconcileTimer);
      this.prReconcileTimer = null;
    }
  }

  /** For testing: check if a session key exists */
  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /** For testing: count active sessions */
  size(): number {
    return this.sessions.size;
  }

  /** Dispose all sessions (cleanup) */
  async disposeAll(): Promise<void> {
    this.stopVolumeGc();
    this.stopPrReconciliation();
    const keys = Array.from(this.sessions.keys());
    for (const key of keys) {
      await this.reapSession(key, true);
    }
  }
}
