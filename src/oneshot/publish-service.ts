/**
 * RealPublishService — the real PublishService implementation.
 *
 * Closes over broker + gitNodes; mints a WRITE lease per publish request, pushes the
 * session volume's verified worktree, opens a PR, then revokes the lease in a finally.
 * The credential never enters the agent env. Never throws — outcomes are returned as data.
 */

import type { PublishOutcome, PublishService, PublishServiceRequest } from '../runner/publish-service.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { branchForTask, taskIdFromWorkspaceVolume, workdirForRepo } from './orchestrator.js';
import { composePrBodyFromParts, titleFromInstruction } from './nodes/open-pr.js';

/**
 * A strict "owner/name" slug. Publish targets are model-provided and untrusted, then used to
 * derive the local workdir and broker lease. Reject traversal, extra segments, and URL/path
 * metacharacters before leasing or running git.
 */
const SAFE_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const FALLBACK_TITLE_SOURCE = 'Publish verified changes';

function cleanOptionalText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

export class RealPublishService implements PublishService {
  constructor(
    private readonly broker: CredentialBroker,
    private readonly gitNodes: GitNodeExecutor,
  ) {}

  async publish(req: PublishServiceRequest): Promise<PublishOutcome> {
    if (!SAFE_REPO_SLUG.test(req.repo)) {
      return { ok: false, reason: 'invalid repo (expected "owner/name")' };
    }

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const branch = branchForTask(taskIdFromWorkspaceVolume(req.volume));
    const workdir = workdirForRepo(req.repo);
    const title = cleanOptionalText(req.title) ?? titleFromInstruction(FALLBACK_TITLE_SOURCE);
    const body =
      cleanOptionalText(req.body) ??
      composePrBodyFromParts({
        title,
        instruction: FALLBACK_TITLE_SOURCE,
      });

    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({ host: 'github', repo: req.repo, taskId });
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try { await lease.revoke(); } catch { /* best effort */ }
    };

    try {
      await this.gitNodes.push({
        lease,
        repo: req.repo,
        branch,
        workdir,
        volume: req.volume,
      });
      const { url } = await this.gitNodes.openChangeRequest({
        lease,
        repo: req.repo,
        head: branch,
        base: 'main',
        title,
        body,
      });
      return { ok: true, prUrl: url };
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await revokeOnce();
    }
  }
}
