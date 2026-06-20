/**
 * Unit tests for the runChecks helper (runner/src/main.ts).
 */

import { describe, it, expect } from 'vitest';
import { runChecks } from '../src/main.js';
import type { ChecksInput, ChecksOutcome } from '../src/checks.js';

function recorder(outcome: ChecksOutcome): {
  calls: ChecksInput[];
  run: (input: ChecksInput) => Promise<ChecksOutcome>;
} {
  const calls: ChecksInput[] = [];
  return {
    calls,
    run: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
}

describe('runChecks', () => {
  it('defaults to all and returns raw output with exit/skipped metadata', async () => {
    const r = recorder({
      ok: true,
      results: [
        { kind: 'lint', exitCode: 1, skipped: false, output: 'lint raw\nline 2' },
        { kind: 'test', exitCode: 0, skipped: true, output: 'no test script' },
      ],
    });

    const text = await runChecks({ repo: 'owner/repo' }, r.run);

    expect(r.calls).toEqual([{ repo: 'owner/repo', kind: 'all' }]);
    expect(text).toContain('RUN CHECKS COMPLETE');
    expect(text).toContain('Requested kind: all');
    expect(text).toContain('CHECK lint');
    expect(text).toContain('exitCode: 1');
    expect(text).toContain('skipped: false');
    expect(text).toContain('<raw_output kind="lint">');
    expect(text).toContain('lint raw\nline 2');
    expect(text).toContain('CHECK test');
    expect(text).toContain('skipped: true');
    expect(text).toContain('no test script');
  });

  it('returns infrastructure failure reason', async () => {
    const r = recorder({ ok: false, reason: 'run_checks unavailable' });

    const text = await runChecks({ repo: 'owner/repo', kind: 'lint' }, r.run);

    expect(r.calls).toEqual([{ repo: 'owner/repo', kind: 'lint' }]);
    expect(text).toContain('RUN CHECKS DID NOT COMPLETE: run_checks unavailable');
  });
});
