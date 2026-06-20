/**
 * Unit tests for RealCheckService (src/oneshot/check-service.ts).
 */

import { describe, it, expect } from 'vitest';
import { FakeGitNodeExecutor } from '../src/oneshot/fake-git-node.js';
import { RealCheckService } from '../src/oneshot/check-service.js';

describe('RealCheckService', () => {
  it('rejects an invalid repo slug before verifying or checking', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealCheckService(gitNodes);

    for (const bad of ['../etc/passwd', '../repo', 'owner/..', './repo', 'owner/.', 'owner', 'owner/repo/extra', 'owner/re po', '']) {
      const outcome = await svc.runChecks({ repo: bad, volume: 'vol' });
      expect(outcome.ok).toBe(false);
    }

    expect(gitNodes.repoVerifications).toHaveLength(0);
    expect(gitNodes.checks).toHaveLength(0);
    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });

  it('verifies repo binding before running checks', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setCheckResult('lint', { exitCode: 0, skipped: false, output: 'lint ok' });
    const svc = new RealCheckService(gitNodes);

    const outcome = await svc.runChecks({ repo: 'owner/repo', volume: 'vol', kind: 'lint' });

    expect(outcome).toEqual({
      ok: true,
      results: [{ kind: 'lint', exitCode: 0, skipped: false, output: 'lint ok' }],
    });
    expect(gitNodes.repoVerifications).toEqual([{
      repo: 'owner/repo',
      workdir: '/workspace/owner-repo',
      volume: 'vol',
    }]);
    expect(gitNodes.checks).toEqual([{
      kind: 'lint',
      repo: 'owner/repo',
      workdir: '/workspace/owner-repo',
      volume: 'vol',
    }]);
  });

  it('all kind runs lint then test in order', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setCheckResult('lint', { exitCode: 0, skipped: false, output: 'lint ok' });
    gitNodes.setCheckResult('test', { exitCode: 0, skipped: true, output: 'no tests' });
    const svc = new RealCheckService(gitNodes);

    const outcome = await svc.runChecks({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({
      ok: true,
      results: [
        { kind: 'lint', exitCode: 0, skipped: false, output: 'lint ok' },
        { kind: 'test', exitCode: 0, skipped: true, output: 'no tests' },
      ],
    });
    expect(gitNodes.checks.map((c) => c.kind)).toEqual(['lint', 'test']);
  });

  it('non-zero check exit returns ok:true', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setCheckResult('test', { exitCode: 2, skipped: false, output: 'tests failed' });
    const svc = new RealCheckService(gitNodes);

    const outcome = await svc.runChecks({ repo: 'owner/repo', volume: 'vol', kind: 'test' });

    expect(outcome).toEqual({
      ok: true,
      results: [{ kind: 'test', exitCode: 2, skipped: false, output: 'tests failed' }],
    });
  });

  it('repo binding mismatch returns ok:false before checks', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.setVerifyRepoResult(false);
    const svc = new RealCheckService(gitNodes);

    const outcome = await svc.runChecks({ repo: 'owner/repo', volume: 'vol' });

    expect(outcome).toEqual({ ok: false, reason: 'repo binding mismatch' });
    expect(gitNodes.repoVerifications).toHaveLength(1);
    expect(gitNodes.checks).toHaveLength(0);
  });

  it('thrown runCheck returns ok:false with a short reason', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    gitNodes.failNextCheck(new Error('secret stack detail'));
    const svc = new RealCheckService(gitNodes);

    const outcome = await svc.runChecks({ repo: 'owner/repo', volume: 'vol', kind: 'lint' });

    expect(outcome).toEqual({ ok: false, reason: 'run checks failed' });
  });

  it('does not push or open a PR', async () => {
    const gitNodes = new FakeGitNodeExecutor();
    const svc = new RealCheckService(gitNodes);

    await svc.runChecks({ repo: 'owner/repo', volume: 'vol', kind: 'lint' });

    expect(gitNodes.pushes).toHaveLength(0);
    expect(gitNodes.changeRequests).toHaveLength(0);
  });
});
