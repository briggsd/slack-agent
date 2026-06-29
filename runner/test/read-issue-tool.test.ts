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
  it('returns formatted issue text on success with no comments', async () => {
    const r = recorder({
      ok: true,
      issue: {
        title: 'Fix the bug',
        body: 'Steps to reproduce.',
        state: 'open',
        author: 'reporter',
        comments: [],
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 42 }, r.readIssue);

    expect(r.calls).toEqual([{ host: 'github', repo: 'owner/repo', number: 42 }]);
    expect(text).toContain('ISSUE #42');
    expect(text).toContain('open');
    expect(text).toContain('Fix the bug');
    expect(text).toContain('Author: reporter');
    expect(text).toContain('Steps to reproduce.');
    expect(text).toContain('--- COMMENTS (0) ---');
    expect(text).toContain('No comments.');
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
        comments: [],
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 1 }, r.readIssue);

    expect(text).toContain('closed');
    expect(text).toContain('Author: closer');
  });

  it('renders comments section with numbered entries', async () => {
    const r = recorder({
      ok: true,
      issue: {
        title: 'Reviewed PR',
        body: 'PR body.',
        state: 'open',
        author: 'author1',
        comments: [
          { author: 'alice', body: 'LGTM!' },
          { author: 'bob', body: 'Please add tests.' },
        ],
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 10 }, r.readIssue);

    expect(text).toContain('--- COMMENTS (2) ---');
    expect(text).toContain('[1] alice:');
    expect(text).toContain('LGTM!');
    expect(text).toContain('[2] bob:');
    expect(text).toContain('Please add tests.');
    expect(text).not.toContain('No comments.');
  });

  it('empty thread shows header and No comments. sentinel', async () => {
    const r = recorder({
      ok: true,
      issue: {
        title: 'Empty thread',
        body: 'No discussion yet.',
        state: 'open',
        author: 'op',
        comments: [],
      },
    });

    const text = await runReadIssue({ host: 'github', repo: 'owner/repo', number: 5 }, r.readIssue);

    expect(text).toContain('--- COMMENTS (0) ---');
    expect(text).toContain('No comments.');
  });
});
