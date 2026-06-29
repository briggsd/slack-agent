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

/**
 * Maximum number of comments returned per issue read. We keep the NEWEST ones:
 * GitHub returns comments oldest-first, and the most recent comment is the one
 * the agent most needs (e.g. the CI review-factory's summary is posted last), so
 * within the fetched page we drop the oldest entries, not the newest.
 *
 * Caveat (bounded): getIssueComments fetches a single per_page=100 page, so on a
 * thread with MORE than 100 comments that page holds the oldest 100 and the truly
 * newest comment is not fetched at all. That edge (>100 comments on one issue/PR)
 * is out of scope for this slice; last-page Link pagination is tracked as a
 * follow-up. Realistic bot-read threads are far under 100.
 */
export const READ_ISSUE_COMMENTS_MAX = 30;

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
      const provider = providerFor(lease.host);
      // The issue and its comments are independent reads under the same lease —
      // fetch them concurrently so the gateway-serviced tool blocks the agent
      // turn for one round-trip, not two. A failure in either rejects the
      // Promise.all and falls into the catch below (comments errors fail the read
      // rather than silently dropping review feedback).
      const [raw, rawComments] = await Promise.all([
        provider.getIssue({
          repo: req.repo,
          number: req.number,
          token: lease.token,
          fetchFn: this.fetchFn,
        }),
        provider.getIssueComments({
          repo: req.repo,
          number: req.number,
          token: lease.token,
          fetchFn: this.fetchFn,
        }),
      ]);
      const body = raw.body.length > READ_ISSUE_BODY_MAX ? raw.body.slice(0, READ_ISSUE_BODY_MAX) : raw.body;
      // Keep the newest READ_ISSUE_COMMENTS_MAX of the fetched page (GitHub returns
      // oldest-first). See READ_ISSUE_COMMENTS_MAX for the >100-comment caveat.
      const comments = rawComments.slice(-READ_ISSUE_COMMENTS_MAX).map((c) => ({
        author: c.author,
        body: c.body.length > READ_ISSUE_BODY_MAX ? c.body.slice(0, READ_ISSUE_BODY_MAX) : c.body,
      }));
      return { ok: true, issue: { ...raw, body, comments } };
    } catch (err) {
      return { ok: false, reason: safeReasonFrom(err) };
    } finally {
      await lease.revoke();
    }
  }
}
