/**
 * Container-side publish/edit/comment coordinators.
 *
 * The `publish`/`open_pr`, `edit_pr`, and `comment_pr` tools emit request_* lines to the gateway
 * and block on promises. The runner's stdin dispatcher routes the matching *_result messages back
 * in here so the waiting tools can resume.
 */

import type { PublishResultMessage, PrEditResultMessage, PrCommentResultMessage } from './protocol.js';

/** The outcome of publishing, as the publish tool sees it. */
export type PublishOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

export interface PublishInput {
  repo: string;
  title?: string;
  body?: string;
}

export type PrEditOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export interface PrEditInput {
  repo: string;
  title?: string;
  body?: string;
}

export type PrCommentOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export interface PrCommentInput {
  repo: string;
  comment: string;
}

/** Emits a `request_publish` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestPublishFn = (input: PublishInput, id: string) => void;
export type EmitRequestPrEditFn = (input: PrEditInput, id: string) => void;
export type EmitRequestPrCommentFn = (input: PrCommentInput, id: string) => void;

class RequestCoordinator<TInput, TResultMessage extends { id: string }, TOutcome> {
  private readonly pending = new Map<string, (outcome: TOutcome) => void>();
  private seq = 0;
  private drained = false;

  constructor(
    private readonly prefix: string,
    private readonly emitRequest: (input: TInput, id: string) => void,
    private readonly fromMessage: (msg: TResultMessage) => TOutcome,
    private readonly shutdownOutcome: TOutcome,
  ) {}

  request(input: TInput): Promise<TOutcome> {
    if (this.drained) {
      return Promise.resolve(this.shutdownOutcome);
    }
    const id = `${this.prefix}-${++this.seq}`;
    return new Promise<TOutcome>((resolve) => {
      this.pending.set(id, resolve);
      this.emitRequest(input, id);
    });
  }

  handleResult(msg: TResultMessage): boolean {
    const resolve = this.pending.get(msg.id);
    if (resolve === undefined) return false;
    this.pending.delete(msg.id);
    resolve(this.fromMessage(msg));
    return true;
  }

  failAllPending(): void {
    this.drained = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(this.shutdownOutcome);
    }
  }
}

export class PublishCoordinator {
  private readonly base: RequestCoordinator<PublishInput, PublishResultMessage, PublishOutcome>;

  constructor(emitRequest: EmitRequestPublishFn) {
    this.base = new RequestCoordinator(
      'publish',
      emitRequest,
      (msg) => msg.ok ? { ok: true, prUrl: msg.prUrl ?? '' } : { ok: false, reason: msg.reason ?? 'publish failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  requestPublish(input: PublishInput): Promise<PublishOutcome> {
    return this.base.request(input);
  }

  handleResult(msg: PublishResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  failAllPending(): void {
    this.base.failAllPending();
  }
}

export class EditPrCoordinator {
  private readonly base: RequestCoordinator<PrEditInput, PrEditResultMessage, PrEditOutcome>;

  constructor(emitRequest: EmitRequestPrEditFn) {
    this.base = new RequestCoordinator(
      'pr-edit',
      emitRequest,
      (msg) => msg.ok ? { ok: true } : { ok: false, reason: msg.reason ?? 'edit PR failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  requestEditPr(input: PrEditInput): Promise<PrEditOutcome> {
    return this.base.request(input);
  }

  handleResult(msg: PrEditResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  failAllPending(): void {
    this.base.failAllPending();
  }
}

export class CommentPrCoordinator {
  private readonly base: RequestCoordinator<PrCommentInput, PrCommentResultMessage, PrCommentOutcome>;

  constructor(emitRequest: EmitRequestPrCommentFn) {
    this.base = new RequestCoordinator(
      'pr-comment',
      emitRequest,
      (msg) => msg.ok ? { ok: true } : { ok: false, reason: msg.reason ?? 'comment PR failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  requestCommentPr(input: PrCommentInput): Promise<PrCommentOutcome> {
    return this.base.request(input);
  }

  handleResult(msg: PrCommentResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  failAllPending(): void {
    this.base.failAllPending();
  }
}
