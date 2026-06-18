import type { BlueprintNode, BlueprintContext, NodeDeps } from '../types.js';
import type { RunnerEvent } from '../../../runner/types.js';

export const openPrNode: BlueprintNode = {
  name: 'open-pr',
  kind: 'deterministic',
  async *run(ctx: BlueprintContext, deps: NodeDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'opening pull request…' };

    // Title: first ~72 chars of the instruction (first line)
    const title = ctx.instruction.split('\n')[0]?.slice(0, 72) ?? ctx.instruction.slice(0, 72);
    const implementSummary = ctx.implementSummary ?? '';
    const body = implementSummary !== ''
      ? implementSummary.slice(0, 500)
      : `Automated one-shot implementation.\n\nTask: ${title}`;

    const { url } = await deps.gitNodes.openChangeRequest({
      lease: ctx.lease,
      repo: ctx.repo,
      head: ctx.branch,
      base: 'main',
      title,
      body,
    });

    ctx.prUrl = url;
    yield { type: 'text', text: `Opened PR: ${url}` };
  },
};
