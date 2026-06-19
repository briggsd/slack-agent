import type { RunnerFactory, SessionRunner, GateResume } from '../runner/types.js';
import type { SlackClientLike, Placeholder } from '../slack/responder.js';
import { postPlaceholder, updatePlaceholder } from '../slack/responder.js';
import { getProfile, DEFAULT_PROFILE_ID } from '../profiles/registry.js';
import type { SessionStore } from './store.js';
import { NoopSessionStore } from './store.js';

export interface QueueItem {
  message: string;
  channel: string;
  threadTs: string;
  teamId?: string;
  userId?: string;
  profileId?: string;
}

interface Session {
  key: string;
  runner: SessionRunner;
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
   * Set while a run is parked at an `await_approval` gate. The next thread reply
   * resolves it (with the reply text) instead of being enqueued as a new turn; a
   * timer resolves it with a timeout if no reply arrives. Null when not parked.
   */
  pendingApproval: { resolve: (resume: GateResume) => void } | null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly idleTimeoutMs: number;
  private readonly gateTimeoutMs: number;
  private readonly factory: RunnerFactory;
  private readonly slack: SlackClientLike;
  private readonly store: SessionStore;

  constructor(opts: {
    idleTimeoutMs: number;
    /** How long a run parked at an approval gate waits for a reply before the
     *  fallback fires (the run resumes with a `timeout` resume). Default 15 min. */
    gateTimeoutMs?: number;
    factory: RunnerFactory;
    slack: SlackClientLike;
    store?: SessionStore;
  }) {
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.gateTimeoutMs = opts.gateTimeoutMs ?? 15 * 60 * 1000;
    this.factory = opts.factory;
    this.slack = opts.slack;
    this.store = opts.store ?? new NoopSessionStore();
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
   */
  private async getOrCreate(key: string, item: QueueItem): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      this.resetIdleTimer(existing);
      return existing;
    }
    const profileId = item.profileId;
    const profile = getProfile(profileId ?? DEFAULT_PROFILE_ID);
    const runner = await this.factory.create(key, profile);
    const now = Date.now();
    const session: Session = {
      key,
      runner,
      queue: [],
      draining: false,
      idleTimer: null,
      requestorUserId: item.userId,
      pendingApproval: null,
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
      created_at: now,
      last_active_at: now,
      status: 'active',
    });

    return session;
  }

  /**
   * Enqueue a message for a session, creating the session if needed (for mentions).
   */
  async enqueueNew(key: string, item: QueueItem): Promise<void> {
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
      // A run parked at an approval gate: this reply IS the approval/redirect — hand
      // it to the waiting run instead of enqueuing it as a new turn.
      //
      // SECURITY (M6 #22):
      // (1) Gate authorization — resolution is REQUESTOR-ONLY (M6 S04). Only the user who
      //     started the thread may approve/cancel/redirect a parked plan; this one check
      //     gates all three paths. Fail-closed: an unknown requestor (undefined) matches
      //     nobody, so the gate rides to its timeout-abandon rather than letting anyone in.
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
          // either (a parked supervised one-shot owns the thread until it resolves).
          // Post a NEW threaded message (never an update() to the gate placeholder,
          // which must keep showing the plan + prompt for the requestor); ping the
          // requestor by name for accountability.
          // TODO(M6 audit): emit an audit_events row for the rejected resolve attempt.
          console.log(`[session] gate reply from non-requestor ignored: ${session.key}`);
          const who =
            session.requestorUserId !== undefined
              ? `<@${session.requestorUserId}>`
              : 'the person who started this task';
          void this.slack
            .postMessage({
              channel: item.channel,
              thread_ts: item.threadTs,
              text: `Only ${who} can approve or cancel this plan.`,
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
        session.pendingApproval.resolve({ kind: 'reply', text: item.message });
        return true;
      }
      // Normal in-memory hit — unchanged behaviour.
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
    // Rehydrate: recreate the runner from the stored profile_id.
    console.log(`[session] rehydrating evicted session: ${key}`);
    const rehydrated = await this.getOrCreate(key, {
      message: item.message,
      channel: item.channel,
      threadTs: item.threadTs,
      // Prefer stored profile so we honour what the session was originally created with.
      profileId: row.profile_id,
      ...(item.teamId !== undefined && { teamId: item.teamId }),
      // Source the requestor from the STORED row, not the replying message, so gate
      // authz (M6 #22) stays bound to the original starter. Omitted when null →
      // fail-closed (no one can resolve a rehydrated gate with no recorded requestor).
      ...(row.user_id !== null && { userId: row.user_id }),
    });
    rehydrated.queue.push(item);
    void this.drain(rehydrated);
    return true;
  }

  private resetIdleTimer(session: Session): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    const timer = setTimeout(() => {
      void this.reapSession(session.key);
    }, this.idleTimeoutMs);
    // Allow the process to exit even if this timer is pending
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
    session.idleTimer = timer;
  }

  private async reapSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) return;
    // Never reap mid-turn: a long-running turn would lose its runner. Try again later.
    if (session.draining) {
      this.resetIdleTimer(session);
      return;
    }
    this.sessions.delete(key);
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    console.log(`[session] reaping idle session: ${key}`);
    this.store.setStatus(key, 'reaped');
    await session.runner.dispose();
  }

  private async drain(session: Session): Promise<void> {
    if (session.draining) return;
    session.draining = true;

    while (session.queue.length > 0) {
      const item = session.queue.shift();
      if (item === undefined) break;

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

        // Drive the run manually (not `for await`) so a gate's reply can be fed back
        // via `next(resume)`. `resume` is undefined for every event except resuming a
        // parked `await_approval`; conversational runs never yield one, so this is
        // behaviourally identical to the old loop for them. A RunnerStream is its own
        // async iterator, so no `[Symbol.asyncIterator]()` is needed.
        const iterator = session.runner.send(item.message);
        let resume: GateResume | undefined;
        try {
          while (true) {
            const result = await iterator.next(resume);
            resume = undefined;
            if (result.done === true) break;
            const event = result.value;
            if (event.type === 'status') {
              await updatePlaceholder(this.slack, placeholder, `_${event.text}_`);
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
                await updatePlaceholder(
                  this.slack,
                  placeholder,
                  `:x: Failed to upload file ${event.name}: ${uploadMsg}`,
                );
              }
            } else if (event.type === 'text') {
              await updatePlaceholder(this.slack, placeholder, event.text);
            } else if (event.type === 'await_approval') {
              // Park: post the plan, wait for the next thread reply (or a timeout), and
              // feed the result back into the run on the next `next()`.
              resume = await this.awaitApproval(session, placeholder, event.prompt);
            } else if (event.type === 'abandoned') {
              // A gate deliberately ended the run (cancel/timeout). Post a clean, non-error
              // line and stop driving — the `finally` below calls iterator.return(), which
              // unwinds the run's own `finally` blocks (notably the orchestrator's lease
              // revoke). No downstream nodes (branch/push/open-pr) run.
              await updatePlaceholder(
                this.slack,
                placeholder,
                `:no_entry_sign: Plan abandoned (${event.reason}) — nothing was pushed.`,
              );
              break;
            } else if (event.type === 'error') {
              await updatePlaceholder(
                this.slack,
                placeholder,
                `:x: Error: ${event.message}`,
              );
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[session] error processing message in ${session.key}: ${msg}`);
        if (placeholder !== null) {
          try {
            await updatePlaceholder(
              this.slack,
              placeholder,
              `:x: Unexpected error: ${msg}`,
            );
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
    // Register the parked state SYNCHRONOUSLY (the Promise executor runs now), before
    // any await — so a reply that arrives while the prompt is still being posted is
    // routed to the gate by enqueueExisting, not enqueued as a brand-new turn.
    const result = new Promise<GateResume>((resolve) => {
      const settle = (resume: GateResume): void => {
        if (session.pendingApproval === null) return; // already settled by the other path
        clearTimeout(timer);
        session.pendingApproval = null;
        resolve(resume);
      };
      const timer = setTimeout(() => settle({ kind: 'timeout' }), this.gateTimeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      session.pendingApproval = { resolve: settle };
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
    const keys = Array.from(this.sessions.keys());
    for (const key of keys) {
      await this.reapSession(key);
    }
  }
}
