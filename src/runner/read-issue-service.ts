/**
 * ReadIssueService interface — the gateway-side seam for reading a repository issue
 * on behalf of the agent (the credential never enters the agent env).
 *
 * The interface lives in src/runner/ so docker.ts can import it without a circular dep.
 * The real implementation (RealReadIssueService) lives in src/oneshot/.
 */

import type { GitHost } from '../broker/types.js';

export interface ReadIssueServiceRequest {
  host: GitHost;
  repo: string;
  number: number;
}

export interface IssueComment {
  author: string;  // commenter login, '' if absent
  body: string;    // capped at READ_ISSUE_BODY_MAX
}

export interface IssueData {
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  comments: IssueComment[];
}

export type ReadIssueOutcome =
  | { ok: true; issue: IssueData }
  | { ok: false; reason: string };

export interface ReadIssueService {
  readIssue(req: ReadIssueServiceRequest): Promise<ReadIssueOutcome>;
}
