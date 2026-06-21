/**
 * RealCloneService — the real CloneService implementation.
 *
 * Closes over broker + gitNodes; mints a READ lease per clone request,
 * performs the credentialed git clone via gitNodes.clone(), then revokes the
 * lease in a finally. The credential never enters the agent env: the clone
 * runs via GitNodeExecutor (an ephemeral docker container with the token
 * in its ENV, never in argv). Never throws — outcomes are returned as data.
 */

import type { CloneService, CloneServiceRequest, CloneOutcome } from '../runner/clone-service.js';
import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import type { GitNodeExecutor } from './git-node.js';

/**
 * A strict "owner/name" slug. The repo is model-chosen (the agent names it via the
 * clone_repo tool) and untrusted, then interpolated into the clone URL and the workdir
 * path — so validate its shape before leasing/cloning, mirroring SAFE_USERNAME in
 * docker-git-node.ts. Rejects traversal ('../'), extra path segments, and URL-meaningful
 * characters. Defense-in-depth: the host is hardcoded and git runs via argv (no shell).
 */
const SAFE_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export class RealCloneService implements CloneService {
  constructor(
    private readonly broker: CredentialBroker,
    private readonly gitNodes: GitNodeExecutor,
    private readonly opts: { allowedRepos: ReadonlySet<string> },
  ) {}

  async clone(req: CloneServiceRequest): Promise<CloneOutcome> {
    if (!SAFE_REPO_SLUG.test(req.repo)) {
      return { ok: false, error: 'invalid repo (expected "owner/name")' };
    }
    if (!this.opts.allowedRepos.has(req.repo.toLowerCase())) {
      return { ok: false, error: 'repo not allowed' };
    }
    // Correlation id mirrors orchestrator.ts style
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // Derive workdir: all slashes → dashes (same recipe as orchestrator.ts)
    const workdir = `/workspace/${req.repo.replaceAll('/', '-')}`;

    // Mint a read lease — host defaults to 'github' (only configured host; multi-host banked)
    let lease: CredentialLease;
    try {
      lease = await this.broker.lease({ host: 'github', repo: req.repo, taskId });
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let leaseRevoked = false;
    const revokeOnce = async (): Promise<void> => {
      if (leaseRevoked) return;
      leaseRevoked = true;
      try { await lease.revoke(); } catch { /* best effort */ }
    };

    try {
      await this.gitNodes.clone({ lease, repo: req.repo, workdir, volume: req.volume, shallow: true });
      return { ok: true, workdir };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await revokeOnce();
    }
  }
}
