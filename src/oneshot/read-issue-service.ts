/**
 * RealReadIssueService — the real ReadIssueService implementation.
 *
 * Mints a READ lease per request, hits the host's issue API, caps the body,
 * then revokes the lease in a finally. The credential never enters the agent env.
 * Never throws — outcomes are returned as data.
 */

import type {
  ReadIssueOutcome,
  ReadIssueService,
  ReadIssueServiceRequest,
} from '../runner/read-issue-service.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { FetchFn } from './git-host.js';
import { providerFor } from './git-host.js';
import { isSafeRepoSlug } from './parse.js';

/** Maximum issue body length returned to the agent (untrusted external text). */
export const READ_ISSUE_BODY_MAX = 16_384;

function isSafeOwnerRepoSlug(repo: string): boolean {
  return repo.split('/').length === 2 && isSafeRepoSlug(repo);
}

function safeReasonFrom(err: unknown): string {
  if (err instanceof Error) {
    // Trim to a short, token-free reason. Never embed the full error chain.
    return err.message.slice(0, 200);
  }
  return 'unknown error';
}

export class RealReadIssueService implements ReadIssueService {
  constructor(
    private readonly broker: CredentialBroker,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async readIssue(req: ReadIssueServiceRequest): Promise<ReadIssueOutcome> {
    if (!isSafeOwnerRepoSlug(req.repo) || !Number.isInteger(req.number) || req.number <= 0) {
      return { ok: false, reason: 'invalid repo or issue number' };
    }

    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({
        host: req.host,
        repo: req.repo,
        taskId: `read-issue:${req.repo}#${req.number}`,
      });
    } catch {
      return { ok: false, reason: 'credential lease failed' };
    }

    try {
      const raw = await providerFor(lease.host).getIssue({
        repo: req.repo,
        number: req.number,
        token: lease.token,
        fetchFn: this.fetchFn,
      });
      const body = raw.body.length > READ_ISSUE_BODY_MAX ? raw.body.slice(0, READ_ISSUE_BODY_MAX) : raw.body;
      return { ok: true, issue: { ...raw, body } };
    } catch (err) {
      return { ok: false, reason: safeReasonFrom(err) };
    } finally {
      await lease.revoke();
    }
  }
}
