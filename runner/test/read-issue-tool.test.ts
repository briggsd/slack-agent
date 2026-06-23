import { describe, it, expect } from 'vitest';
import { runReadIssue } from '../src/main.js';
import type { ReadIssueInput, ReadIssueOutcome } from '../src/read-issue.js';

function recorder(outcome: ReadIssueOutcome): {
  calls: ReadIssueInput[];
  readIssue: (input: ReadIssueInput) => Promise<ReadIssueOutcome>;
} {
  const calls: ReadIssueInput[] = [];
  return {
    calls,
    readIssue: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
}

describe('runReadIssue', () => {
  it('returns formatted issue text on success', async () => {
    const r = recorder({
      ok: true,
      issue: {
        title: 'Fix the bug',
        body: 'Steps to reproduce.',
        state: 'open',
        author: 'reporter',
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 42 }, r.readIssue);

    expect(r.calls).toEqual([{ host: 'github', repo: 'owner/repo', number: 42 }]);
    expect(text).toContain('ISSUE #42');
    expect(text).toContain('open');
    expect(text).toContain('Fix the bug');
    expect(text).toContain('Author: reporter');
    expect(text).toContain('Steps to reproduce.');
  });

  it('returns the failure reason text on failure', async () => {
    const r = recorder({ ok: false, reason: 'Not Found' });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 999 }, r.readIssue);

    expect(r.calls).toEqual([{ host: 'github', repo: 'owner/repo', number: 999 }]);
    expect(text).toContain('READ ISSUE DID NOT COMPLETE: Not Found');
  });

  it('returns the closed state in the formatted output', async () => {
    const r = recorder({
      ok: true,
      issue: {
        title: 'Old issue',
        body: '',
        state: 'closed',
        author: 'closer',
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 1 }, r.readIssue);

    expect(text).toContain('closed');
    expect(text).toContain('Author: closer');
  });
});
