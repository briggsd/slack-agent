import type { SlackClientLike } from './responder.js';

/** Fake Slack client that records all calls */
export class FakeSlackClient implements SlackClientLike {
  public posts: Array<{ channel: string; thread_ts: string; text: string }> = [];
  public updates: Array<{ channel: string; ts: string; text: string }> = [];
  public uploads: Array<{ channel: string; thread_ts: string; filename: string; data: Buffer }> = [];
  /** When set, uploadFile rejects with this error */
  public uploadError: Error | null = null;
  private nextTs = 1;

  async postMessage(params: {
    channel: string;
    thread_ts: string;
    text: string;
  }): Promise<{ ts: string }> {
    this.posts.push({ ...params });
    return { ts: String(this.nextTs++) };
  }

  async update(params: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<void> {
    this.updates.push({ ...params });
  }

  async uploadFile(params: {
    channel: string;
    thread_ts: string;
    filename: string;
    data: Buffer;
  }): Promise<void> {
    if (this.uploadError !== null) {
      throw this.uploadError;
    }
    this.uploads.push({ ...params });
  }
}
