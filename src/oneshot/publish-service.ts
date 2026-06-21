/**
 * RealPublishService — the real PublishService implementation.
 *
 * Closes over broker + gitNodes; mints a WRITE lease per publish request, pushes the
 * session volume's verified worktree, opens a PR, then revokes the lease in a finally.
 * The credential never enters the agent env. Never throws — outcomes are returned as data.
 */

import type {
  PublishOutcome,
  PublishService,
  PublishServiceRequest,
  PrEditOutcome,
  PrEditServiceRequest,
  PrCommentOutcome,
  PrCommentServiceRequest,
} from '../runner/publish-service.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';
import { branchForTask, taskIdFromWorkspaceVolume, workdirForRepo } from './orchestrator.js';
import { composePrBodyFromParts, titleFromInstruction } from './nodes/open-pr.js';
import { isSafeRepoSlug } from './parse.js';

const FALLBACK_TITLE_SOURCE = 'Publish verified changes';

function isSafeOwnerRepoSlug(repo: string): boolean {
  return repo.split('/').length === 2 && isSafeRepoSlug(repo);
}

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
    if (!isSafeOwnerRepoSlug(req.repo)) {
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
      });

    if (!(await this.gitNodes.verifyRepo({ repo: req.repo, workdir, volume: req.volume }))) {
      return { ok: false, reason: 'repo binding mismatch' };
    }

    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({ host: 'github', repo: req.repo, taskId });
    } catch {
      return { ok: false, reason: 'credential lease failed' };
    }

    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try { await lease.revoke(); } catch { /* best effort */ }
    };

    try {
      try {
        await this.gitNodes.push({
          lease,
          repo: req.repo,
          branch,
          workdir,
          volume: req.volume,
        });
      } catch {
        return { ok: false, reason: 'git push failed' };
      }

      try {
        const { url, number, headSha } = await this.gitNodes.openChangeRequest({
        lease,
        repo: req.repo,
        head: branch,
        // DockerGitNodeExecutor resolves the repo's actual default branch; this is a fallback
        // for fakes and any executor that chooses to honor the interface field directly.
        base: 'main',
        title,
        body,
        });
        return { ok: true, prUrl: url, prNumber: number, headSha };
      } catch {
        return { ok: false, reason: 'open PR failed' };
      }
    } finally {
      await revokeOnce();
    }
  }

  async editPr(req: PrEditServiceRequest): Promise<PrEditOutcome> {
    if (!isSafeOwnerRepoSlug(req.repo)) {
      return { ok: false, reason: 'invalid repo (expected "owner/name")' };
    }

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const branch = branchForTask(taskIdFromWorkspaceVolume(req.volume));
    const title = cleanOptionalText(req.title);
    const body = cleanOptionalText(req.body);

    // Nothing to change → refuse before leasing. An empty PATCH would lease a credential,
    // round-trip to GitHub for a no-op, and falsely narrate (and audit) a completed edit.
    // Mirrors commentPr, which requires non-empty input.
    if (title === undefined && body === undefined) {
      return { ok: false, reason: 'nothing to edit (provide a title or body)' };
    }

    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({ host: 'github', repo: req.repo, taskId });
    } catch {
      return { ok: false, reason: 'credential lease failed' };
    }

    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try { await lease.revoke(); } catch { /* best effort */ }
    };

    try {
      try {
        const result = await this.gitNodes.editChangeRequest({
          lease,
          repo: req.repo,
          head: branch,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        return 'notFound' in result ? { ok: false, reason: 'no open PR for this thread' } : { ok: true, prUrl: result.prUrl };
      } catch {
        return { ok: false, reason: 'edit PR failed' };
      }
    } finally {
      await revokeOnce();
    }
  }

  async commentPr(req: PrCommentServiceRequest): Promise<PrCommentOutcome> {
    if (!isSafeOwnerRepoSlug(req.repo)) {
      return { ok: false, reason: 'invalid repo (expected "owner/name")' };
    }

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const branch = branchForTask(taskIdFromWorkspaceVolume(req.volume));

    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({ host: 'github', repo: req.repo, taskId });
    } catch {
      return { ok: false, reason: 'credential lease failed' };
    }

    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try { await lease.revoke(); } catch { /* best effort */ }
    };

    try {
      try {
        const result = await this.gitNodes.commentChangeRequest({
          lease,
          repo: req.repo,
          head: branch,
          comment: req.comment,
        });
        return 'notFound' in result ? { ok: false, reason: 'no open PR for this thread' } : { ok: true, prUrl: result.prUrl };
      } catch {
        return { ok: false, reason: 'comment PR failed' };
      }
    } finally {
      await revokeOnce();
    }
  }
}
