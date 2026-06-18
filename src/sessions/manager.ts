import type { RunnerFactory, SessionRunner } from '../runner/types.js';
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
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly idleTimeoutMs: number;
  private readonly factory: RunnerFactory;
  private readonly slack: SlackClientLike;
  private readonly store: SessionStore;

  constructor(opts: {
    idleTimeoutMs: number;
    factory: RunnerFactory;
    slack: SlackClientLike;
    store?: SessionStore;
  }) {
    this.idleTimeoutMs = opts.idleTimeoutMs;
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
      ...item,
      // Prefer stored profile so we honour what the session was originally created with.
      profileId: row.profile_id,
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
      // Bump last_active_at on each turn
      this.store.touch(session.key, Date.now());

      let placeholder: Placeholder | null = null;
      try {
        placeholder = await postPlaceholder(
          this.slack,
          item.channel,
          item.threadTs,
        );

        for await (const event of session.runner.send(item.message)) {
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
          } else if (event.type === 'error') {
            await updatePlaceholder(
              this.slack,
              placeholder,
              `:x: Error: ${event.message}`,
            );
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
