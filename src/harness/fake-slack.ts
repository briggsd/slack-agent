/**
 * Fake Slack adaptor for offline testing and CLI smoke-testing.
 *
 * - CapturingSlackClient: records postMessage/update/uploadFile calls;
 *   optionally echoes to the console when echo:true (CLI use).
 * - FakeSlackApp: records event handlers and exposes fireMention/fireReply
 *   to inject synthetic Slack events without Bolt.
 *
 * Neither this file nor anything it imports may import @slack/bolt.
 */
import type { SlackClientLike } from '../slack/responder.js';
import type { BoltAppLike } from '../slack/listener.js';
import type { MentionEventBody, MessageEventBody } from '../slack/listener.js';

// ─── CapturingSlackClient ─────────────────────────────────────────────────────

export interface CapturedPost {
  channel: string;
  thread_ts: string;
  text: string;
}

export interface CapturedUpdate {
  channel: string;
  ts: string;
  text: string;
}

export interface CapturedUpload {
  channel: string;
  thread_ts: string;
  filename: string;
  data: Buffer;
}

export class CapturingSlackClient implements SlackClientLike {
  public readonly posts: CapturedPost[] = [];
  public readonly updates: CapturedUpdate[] = [];
  public readonly uploads: CapturedUpload[] = [];

  private readonly echo: boolean;
  private nextTs = 1;

  constructor(opts: { echo?: boolean } = {}) {
    this.echo = opts.echo ?? false;
  }

  async postMessage(params: {
    channel: string;
    thread_ts: string;
    text: string;
  }): Promise<{ ts: string }> {
    const ts = String(this.nextTs++);
    this.posts.push({ ...params });
    if (this.echo) {
      console.log(`[slack:post] #${params.channel} thread=${params.thread_ts} → ${params.text}`);
    }
    return { ts };
  }

  async update(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<void> {
    this.updates.push({ ...params });
    if (this.echo) {
      console.log(`[slack:update] #${params.channel} ts=${params.ts} → ${params.text}`);
    }
  }

  async uploadFile(params: {
    channel: string;
    thread_ts: string;
    filename: string;
    data: Buffer;
  }): Promise<void> {
    this.uploads.push({ ...params });
    if (this.echo) {
      console.log(
        `[slack:upload] #${params.channel} thread=${params.thread_ts} file=${params.filename} (${params.data.length} bytes)`,
      );
    }
  }
}

// ─── FakeSlackApp ─────────────────────────────────────────────────────────────

type AnyEventHandler = (args: { body: unknown }) => Promise<void>;

/**
 * Minimal BoltAppLike that records handlers and lets test/harness code fire
 * synthetic events via fireMention / fireReply.
 */
export class FakeSlackApp implements BoltAppLike {
  private readonly handlers = new Map<string, AnyEventHandler>();

  event(type: string, handler: AnyEventHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Inject a synthetic app_mention event.
   * ts doubles as both the event ts and (when no threadTs given) the thread root.
   */
  async fireMention(args: {
    team?: string;
    channel: string;
    threadTs?: string;
    user?: string;
    text: string;
    ts: string;
  }): Promise<void> {
    const body: MentionEventBody = {
      ...(args.team !== undefined && { team_id: args.team }),
      event: {
        type: 'app_mention',
        text: args.text,
        ts: args.ts,
        channel: args.channel,
        ...(args.threadTs !== undefined && { thread_ts: args.threadTs }),
        ...(args.user !== undefined && { user: args.user }),
      },
    };
    const handler = this.handlers.get('app_mention');
    if (handler !== undefined) {
      await handler({ body });
    }
  }

  /**
   * Inject a synthetic thread-reply message event.
   * threadTs is required (only thread replies are routed).
   */
  async fireReply(args: {
    team?: string;
    channel: string;
    threadTs: string;
    user?: string;
    text: string;
    ts: string;
  }): Promise<void> {
    const body: MessageEventBody = {
      ...(args.team !== undefined && { team_id: args.team }),
      event: {
        type: 'message',
        text: args.text,
        ts: args.ts,
        channel: args.channel,
        thread_ts: args.threadTs,
        ...(args.user !== undefined && { user: args.user }),
      },
    };
    const handler = this.handlers.get('message');
    if (handler !== undefined) {
      await handler({ body });
    }
  }
}
