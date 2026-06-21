/**
 * Unit tests for the runBuildSpec helper (runner/src/main.ts, S12b).
 *
 * Tests the exported helper in isolation — no SDK, no stdio, no Docker.
 * Uses fake submitSpec and requestBuild functions to record calls and control outcomes.
 */

import { describe, it, expect } from 'vitest';
import { buildApprovalSpecRef, runBuildSpec } from '../src/main.js';
import type { ReadFileFn } from '../src/main.js';
import type { ApprovalResult } from '../src/approval.js';
import type { BuildOutcome } from '../src/build.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeSubmitSpec(verdict: ApprovalResult): { fn: (specRef: string) => Promise<ApprovalResult>; calls: string[] } {
  const calls: string[] = [];
  return {
    fn: async (specRef: string) => {
      calls.push(specRef);
      return verdict;
    },
    calls,
  };
}

function makeRequestBuild(outcome: BuildOutcome): { fn: (repo: string) => Promise<BuildOutcome>; calls: string[] } {
  const calls: string[] = [];
  return {
    fn: async (repo: string) => {
      calls.push(repo);
      return outcome;
    },
    calls,
  };
}

// ── runBuildSpec ─────────────────────────────────────────────────────────────

describe('runBuildSpec', () => {
  it('invalid repo → refuses before reading SPEC or requesting approval', async () => {
    const readFile: ReadFileFn = async () => {
      throw new Error('should not read');
    };
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo/extra', readFile, submit.fn, build.fn);

    expect(result).toContain('Invalid repo');
    expect(submit.calls).toHaveLength(0);
    expect(build.calls).toHaveLength(0);
  });

  it('null spec → "write SPEC.md first"; submitSpec and requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => null;
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('Write your plan to /workspace/SPEC.md first');
    expect(result).toContain('build_spec');
    expect(submit.calls).toHaveLength(0);
    expect(build.calls).toHaveLength(0);
  });

  it('empty spec → "write SPEC.md first"; submitSpec and requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => '   ';
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('Write your plan to /workspace/SPEC.md first');
    expect(submit.calls).toHaveLength(0);
    expect(build.calls).toHaveLength(0);
  });

  it('requested verdict → text tells the coordinator to end the turn and ask for a reply; requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ status: 'requested' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('APPROVAL REQUESTED');
    expect(result).toContain('End your turn now');
    expect(result).toContain('call build_spec again');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(0);
  });

  it('rejected verdict without feedback → text contains NOT APPROVED; requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ status: 'rejected' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('NOT APPROVED');
    expect(result).toContain('No feedback was given.');
    expect(result).toContain('do not build');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(0);
  });

  it('rejected verdict with feedback → text contains NOT APPROVED and feedback in delimited tag; requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ status: 'rejected', feedback: 'needs more detail' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('NOT APPROVED');
    expect(result).toContain('<human_feedback>');
    expect(result).toContain('needs more detail');
    expect(result).toContain('</human_feedback>');
    expect(result).toContain('do not build');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(0);
  });

  it('approved + build ok → calls requestBuild with the repo, text requires verification before publish', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: true });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('BUILD COMPLETE');
    expect(result).toContain('Local candidate ready');
    expect(result).toContain('inspect the candidate diff');
    expect(result).toContain('read changed files');
    expect(result).toContain('run_checks');
    expect(result).toContain('publish or open_pr');
    expect(result).toContain('Publish only after');
    expect(result).toContain('report honestly');
    expect(result).not.toContain('Opened PR');
    expect(result).not.toContain('offer next steps');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(1);
    expect(build.calls[0]).toBe('owner/repo');
  });

  it('approved + build !ok → calls requestBuild with the repo, text contains failure reason', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: false, reason: 'CI failed: 3 tests red' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('BUILD DID NOT COMPLETE');
    expect(result).toContain('CI failed: 3 tests red');
    expect(result).toContain('build_spec');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(1);
    expect(build.calls[0]).toBe('owner/repo');
  });

  it('submitSpec receives the target repo bound to the spec content', async () => {
    const readFile: ReadFileFn = async (path) => {
      if (path === '/workspace/SPEC.md') return 'The spec content';
      return null;
    };
    const submit = makeSubmitSpec({ status: 'requested' });
    const build = makeRequestBuild({ ok: false, reason: 'unreachable' });

    await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(submit.calls[0]).toBe(buildApprovalSpecRef('owner/repo', 'The spec content'));
    expect(submit.calls[0]).toContain('Target repository: owner/repo');
    expect(submit.calls[0]).toContain('<SPEC.md>\nThe spec content\n</SPEC.md>');
  });

  it('changing only the repo changes the approval payload', () => {
    expect(buildApprovalSpecRef('owner/repo', 'same spec')).not.toBe(
      buildApprovalSpecRef('other/repo', 'same spec'),
    );
  });

  it('repo slug is passed through to requestBuild exactly as provided', async () => {
    const readFile: ReadFileFn = async () => 'spec';
    const submit = makeSubmitSpec({ status: 'approved' });
    const build = makeRequestBuild({ ok: true });

    await runBuildSpec('myorg/my-repo', readFile, submit.fn, build.fn);

    expect(build.calls[0]).toBe('myorg/my-repo');
  });
});
