/**
 * Unit tests for the runPublish helper (runner/src/main.ts).
 */

import { describe, it, expect } from 'vitest';
import { runPublish } from '../src/main.js';
import type { PublishInput, PublishOutcome } from '../src/publish.js';

function recorder(outcome: PublishOutcome): {
  calls: PublishInput[];
  publish: (input: PublishInput) => Promise<PublishOutcome>;
} {
  const calls: PublishInput[] = [];
  return {
    calls,
    publish: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
}

describe('runPublish', () => {
  it('calls the publish callback and returns opened PR text on success', async () => {
    const r = recorder({ ok: true, prUrl: 'https://github.com/owner/repo/pull/1' });

    const text = await runPublish({ repo: 'owner/repo', title: 'Title', body: 'Body' }, r.publish);

    expect(r.calls).toEqual([{ repo: 'owner/repo', title: 'Title', body: 'Body' }]);
    expect(text).toContain('PUBLISH COMPLETE');
    expect(text).toContain('https://github.com/owner/repo/pull/1');
  });

  it('calls the publish callback and returns the failure reason on failure', async () => {
    const r = recorder({ ok: false, reason: 'push failed' });

    const text = await runPublish({ repo: 'owner/repo' }, r.publish);

    expect(r.calls).toEqual([{ repo: 'owner/repo' }]);
    expect(text).toContain('PUBLISH DID NOT COMPLETE: push failed');
  });
});
