/**
 * Container-side read_issue coordinator.
 *
 * The `read_issue` tool emits a `request_read_issue` line to the gateway and blocks
 * on a promise. The runner's stdin dispatcher routes the matching `read_issue_result`
 * message back in here so the waiting tool can resume.
 */

import type { ReadIssueResultMessage, ExecHost } from './protocol.js';
import { RequestCoordinator } from './request-coordinator.js';

/** The outcome of reading an issue, as the read_issue tool sees it. */
export type ReadIssueOutcome =
  | { ok: true; issue: { title: string; body: string; state: 'open' | 'closed'; author: string; comments: { author: string; body: string }[] } }
  | { ok: false; reason: string };

export interface ReadIssueInput {
  host: ExecHost;
  repo: string;
  number: number;
}

/** Emits a `request_read_issue` line. Injected so the coordinator never touches stdout directly. */
export type EmitRequestReadIssueFn = (input: ReadIssueInput, id: string) => void;

export class ReadIssueCoordinator {
  private readonly base: RequestCoordinator<ReadIssueInput, ReadIssueResultMessage, ReadIssueOutcome>;

  constructor(emitRequest: EmitRequestReadIssueFn) {
    this.base = new RequestCoordinator(
      'read-issue',
      emitRequest,
      (msg) =>
        msg.ok && msg.issue !== undefined
          ? { ok: true, issue: msg.issue }
          : { ok: false, reason: msg.reason ?? 'read issue failed' },
      { ok: false, reason: 'shutting down' },
    );
  }

  requestReadIssue(input: ReadIssueInput): Promise<ReadIssueOutcome> {
    return this.base.request(input);
  }

  handleResult(msg: ReadIssueResultMessage): boolean {
    return this.base.handleResult(msg);
  }

  failAllPending(): void {
    this.base.failAllPending();
  }
}
