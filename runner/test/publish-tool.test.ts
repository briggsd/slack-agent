import { describe, it, expect } from 'vitest';
import { runPublish, runEditPr, runCommentPr } from '../src/main.js';
import {
  PublishCoordinator,
  EditPrCoordinator,
  CommentPrCoordinator,
} from '../src/publish.js';
import type {
  PublishInput,
  PublishOutcome,
  PrEditInput,
  PrEditOutcome,
  PrCommentInput,
  PrCommentOutcome,
} from '../src/publish.js';

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
    expect(text).toContain('honest verification report');
    expect(text).toContain('one-line build summary');
    expect(text).toContain('check status only if you actually reviewed run_checks output');
    expect(text).toContain('diff/SPEC assessment only if you inspected the diff');
    expect(text).toContain('Do not overclaim');
    expect(text).not.toContain('offer next steps');
    expect(text).not.toMatch(/Opened PR: https:\/\/github\.com\/owner\/repo\/pull\/1\.$/u);
  });

  it('calls the publish callback and returns the failure reason on failure', async () => {
    const r = recorder({ ok: false, reason: 'push failed' });

    const text = await runPublish({ repo: 'owner/repo' }, r.publish);

    expect(r.calls).toEqual([{ repo: 'owner/repo' }]);
    expect(text).toContain('PUBLISH DID NOT COMPLETE: push failed');
  });
});

function editRecorder(outcome: PrEditOutcome): {
  calls: PrEditInput[];
  editPr: (input: PrEditInput) => Promise<PrEditOutcome>;
} {
  const calls: PrEditInput[] = [];
  return {
    calls,
    editPr: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
}

function commentRecorder(outcome: PrCommentOutcome): {
  calls: PrCommentInput[];
  commentPr: (input: PrCommentInput) => Promise<PrCommentOutcome>;
} {
  const calls: PrCommentInput[] = [];
  return {
    calls,
    commentPr: async (input) => {
      calls.push(input);
      return outcome;
    },
  };
}

describe('runEditPr', () => {
  it('returns success text on success', async () => {
    const r = editRecorder({ ok: true });

    const text = await runEditPr({ repo: 'owner/repo', title: 'T', body: 'B' }, r.editPr);

    expect(r.calls).toEqual([{ repo: 'owner/repo', title: 'T', body: 'B' }]);
    expect(text).toContain('PR EDIT COMPLETE');
  });

  it('returns the failure reason on failure', async () => {
    const r = editRecorder({ ok: false, reason: 'no open PR for this thread' });

    const text = await runEditPr({ repo: 'owner/repo' }, r.editPr);

    expect(r.calls).toEqual([{ repo: 'owner/repo' }]);
    expect(text).toContain('PR EDIT DID NOT COMPLETE: no open PR for this thread');
  });
});

describe('runCommentPr', () => {
  it('returns success text on success', async () => {
    const r = commentRecorder({ ok: true });

    const text = await runCommentPr({ repo: 'owner/repo', comment: 'Hello' }, r.commentPr);

    expect(r.calls).toEqual([{ repo: 'owner/repo', comment: 'Hello' }]);
    expect(text).toContain('PR COMMENT COMPLETE');
  });

  it('returns the failure reason on failure', async () => {
    const r = commentRecorder({ ok: false, reason: 'comment PR failed' });

    const text = await runCommentPr({ repo: 'owner/repo', comment: 'Hello' }, r.commentPr);

    expect(r.calls).toEqual([{ repo: 'owner/repo', comment: 'Hello' }]);
    expect(text).toContain('PR COMMENT DID NOT COMPLETE: comment PR failed');
  });
});

describe('publish/edit/comment coordinators', () => {
  it('PublishCoordinator round-trips success', async () => {
    const emitted: Array<{ input: PublishInput; id: string }> = [];
    const coordinator = new PublishCoordinator((input, id) => {
      emitted.push({ input, id });
    });

    const outcomePromise = coordinator.requestPublish({ repo: 'owner/repo', title: 'T' });
    expect(emitted).toEqual([{ input: { repo: 'owner/repo', title: 'T' }, id: 'publish-1' }]);
    expect(coordinator.handleResult({ type: 'publish_result', id: 'publish-1', ok: true, prUrl: 'http://x/pr/1' })).toBe(true);
    await expect(outcomePromise).resolves.toEqual({ ok: true, prUrl: 'http://x/pr/1' });
    expect(coordinator.handleResult({ type: 'publish_result', id: 'publish-999', ok: true })).toBe(false);
  });

  it('EditPrCoordinator round-trips failure and ignores unknown ids', async () => {
    const emitted: Array<{ input: PrEditInput; id: string }> = [];
    const coordinator = new EditPrCoordinator((input, id) => {
      emitted.push({ input, id });
    });

    const outcomePromise = coordinator.requestEditPr({ repo: 'owner/repo', body: 'B' });
    expect(emitted).toEqual([{ input: { repo: 'owner/repo', body: 'B' }, id: 'pr-edit-1' }]);
    expect(coordinator.handleResult({ type: 'pr_edit_result', id: 'pr-edit-999', ok: true })).toBe(false);
    expect(coordinator.handleResult({ type: 'pr_edit_result', id: 'pr-edit-1', ok: false, reason: 'edit PR failed' })).toBe(true);
    await expect(outcomePromise).resolves.toEqual({ ok: false, reason: 'edit PR failed' });
  });

  it('CommentPrCoordinator round-trips success and failAllPending drains waiting requests', async () => {
    const emitted: Array<{ input: PrCommentInput; id: string }> = [];
    const coordinator = new CommentPrCoordinator((input, id) => {
      emitted.push({ input, id });
    });

    const successPromise = coordinator.requestCommentPr({ repo: 'owner/repo', comment: 'Hello' });
    expect(emitted).toEqual([{ input: { repo: 'owner/repo', comment: 'Hello' }, id: 'pr-comment-1' }]);
    expect(coordinator.handleResult({ type: 'pr_comment_result', id: 'pr-comment-1', ok: true })).toBe(true);
    await expect(successPromise).resolves.toEqual({ ok: true });

    const pendingPromise = coordinator.requestCommentPr({ repo: 'owner/repo', comment: 'Again' });
    coordinator.failAllPending();
    await expect(pendingPromise).resolves.toEqual({ ok: false, reason: 'shutting down' });
    await expect(coordinator.requestCommentPr({ repo: 'owner/repo', comment: 'Late' })).resolves.toEqual({
      ok: false,
      reason: 'shutting down',
    });
  });
});
