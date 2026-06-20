/**
 * RealCheckService — the real CheckService implementation.
 *
 * Runs deterministic lint/test checks against the session volume after verifying
 * the repo binding. No broker is injected here: checks mint no lease and receive
 * no credentials. Never throws — outcomes are returned as data.
 */

import type { CheckOutcome, CheckService, CheckServiceRequest, RunChecksKind } from '../runner/check-service.js';
import type { GitNodeExecutor, CheckResult } from './git-node.js';
import { workdirForRepo } from './orchestrator.js';
import { isSafeRepoSlug } from './parse.js';

function isSafeOwnerRepoSlug(repo: string): boolean {
  return repo.split('/').length === 2 && isSafeRepoSlug(repo);
}

function normalizeKind(kind: RunChecksKind | undefined): RunChecksKind | null {
  if (kind === undefined) return 'all';
  return kind === 'lint' || kind === 'test' || kind === 'all' ? kind : null;
}

export class RealCheckService implements CheckService {
  constructor(private readonly gitNodes: GitNodeExecutor) {}

  async runChecks(req: CheckServiceRequest): Promise<CheckOutcome> {
    if (!isSafeOwnerRepoSlug(req.repo)) {
      return { ok: false, reason: 'invalid repo (expected "owner/name")' };
    }

    const kind = normalizeKind(req.kind);
    if (kind === null) {
      return { ok: false, reason: 'invalid check kind' };
    }

    const workdir = workdirForRepo(req.repo);

    try {
      if (!(await this.gitNodes.verifyRepo({ repo: req.repo, workdir, volume: req.volume }))) {
        return { ok: false, reason: 'repo binding mismatch' };
      }

      const kinds = kind === 'all' ? ['lint', 'test'] as const : [kind] as const;
      const results = [];
      for (const checkKind of kinds) {
        const result: CheckResult = await this.gitNodes.runCheck({
          kind: checkKind,
          repo: req.repo,
          workdir,
          volume: req.volume,
        });
        results.push({ kind: checkKind, exitCode: result.exitCode, skipped: result.skipped, output: result.output });
      }
      return { ok: true, results };
    } catch {
      return { ok: false, reason: 'run checks failed' };
    }
  }
}
