/**
 * Unit tests for the runBuildSpec helper (runner/src/main.ts, S12b).
 *
 * Tests the exported helper in isolation — no SDK, no stdio, no Docker.
 * Uses fake submitSpec and requestBuild functions to record calls and control outcomes.
 */

import { describe, it, expect } from 'vitest';
import { runBuildSpec } from '../src/main.js';
import type { ReadFileFn } from '../src/main.js';
import type { Verdict } from '../src/approval.js';
import type { BuildOutcome } from '../src/build.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeSubmitSpec(verdict: Verdict): { fn: (specRef: string) => Promise<Verdict>; calls: string[] } {
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
  it('null spec → "write SPEC.md first"; submitSpec and requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => null;
    const submit = makeSubmitSpec({ approved: true });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://pr/1' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('Write your plan to /workspace/SPEC.md first');
    expect(result).toContain('build_spec');
    expect(submit.calls).toHaveLength(0);
    expect(build.calls).toHaveLength(0);
  });

  it('empty spec → "write SPEC.md first"; submitSpec and requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => '   ';
    const submit = makeSubmitSpec({ approved: true });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://pr/1' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('Write your plan to /workspace/SPEC.md first');
    expect(submit.calls).toHaveLength(0);
    expect(build.calls).toHaveLength(0);
  });

  it('not-approved verdict without feedback → text contains NOT APPROVED; requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ approved: false });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://pr/1' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('NOT APPROVED');
    expect(result).toContain('No feedback was given.');
    expect(result).toContain('do not build');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(0);
  });

  it('not-approved verdict with feedback → text contains NOT APPROVED and feedback in delimited tag; requestBuild NOT called', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ approved: false, feedback: 'needs more detail' });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://pr/1' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('NOT APPROVED');
    expect(result).toContain('<human_feedback>');
    expect(result).toContain('needs more detail');
    expect(result).toContain('</human_feedback>');
    expect(result).toContain('do not build');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(0);
  });

  it('approved + build ok → calls requestBuild with the repo, text contains PR URL', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ approved: true });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://github.com/owner/repo/pull/42' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('BUILD COMPLETE');
    expect(result).toContain('https://github.com/owner/repo/pull/42');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(1);
    expect(build.calls[0]).toBe('owner/repo');
  });

  it('approved + build !ok → calls requestBuild with the repo, text contains failure reason', async () => {
    const readFile: ReadFileFn = async () => 'My plan';
    const submit = makeSubmitSpec({ approved: true });
    const build = makeRequestBuild({ ok: false, reason: 'CI failed: 3 tests red' });

    const result = await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(result).toContain('BUILD DID NOT COMPLETE');
    expect(result).toContain('CI failed: 3 tests red');
    expect(result).toContain('build_spec');
    expect(submit.calls).toHaveLength(1);
    expect(build.calls).toHaveLength(1);
    expect(build.calls[0]).toBe('owner/repo');
  });

  it('submitSpec receives the spec content from readSpecForApproval', async () => {
    const readFile: ReadFileFn = async (path) => {
      if (path === '/workspace/SPEC.md') return 'The spec content';
      return null;
    };
    const submit = makeSubmitSpec({ approved: false });
    const build = makeRequestBuild({ ok: false, reason: 'unreachable' });

    await runBuildSpec('owner/repo', readFile, submit.fn, build.fn);

    expect(submit.calls[0]).toBe('The spec content');
  });

  it('repo slug is passed through to requestBuild exactly as provided', async () => {
    const readFile: ReadFileFn = async () => 'spec';
    const submit = makeSubmitSpec({ approved: true });
    const build = makeRequestBuild({ ok: true, prUrl: 'https://pr/1' });

    await runBuildSpec('myorg/my-repo', readFile, submit.fn, build.fn);

    expect(build.calls[0]).toBe('myorg/my-repo');
  });
});
