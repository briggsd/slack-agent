import type { RunnerFactory, SessionRunner } from '../runner/types.js';
import type { SlackClientLike, Placeholder } from '../slack/responder.js';
import { postPlaceholder, updatePlaceholder } from '../slack/responder.js';

export interface QueueItem {
  message: string;
  channel: string;
  threadTs: string;
  teamId?: string;
  userId?: string;
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

  constructor(opts: {
    idleTimeoutMs: number;
    factory: RunnerFactory;
    slack: SlackClientLike;
  }) {
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.factory = opts.factory;
    this.slack = opts.slack;
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
   */
  private async getOrCreate(key: string): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      this.resetIdleTimer(existing);
      return existing;
    }
    const runner = await this.factory.create(key);
    const session: Session = {
      key,
      runner,
      queue: [],
      draining: false,
      idleTimer: null,
    };
    this.sessions.set(key, session);
    this.resetIdleTimer(session);
    return session;
  }

  /**
   * Enqueue a message for a session, creating the session if needed (for mentions).
   */
  async enqueueNew(key: string, item: QueueItem): Promise<void> {
    const session = await this.getOrCreate(key);
    session.queue.push(item);
    void this.drain(session);
  }

  /**
   * Enqueue a message into an existing session (for thread replies).
   * Returns false if no session exists for the key.
   */
  enqueueExisting(key: string, item: QueueItem): boolean {
    const session = this.sessions.get(key);
    if (session === undefined) return false;
    this.resetIdleTimer(session);
    session.queue.push(item);
    void this.drain(session);
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
