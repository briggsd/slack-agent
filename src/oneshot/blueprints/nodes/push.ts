import type { BlueprintNode, BlueprintContext, NodeDeps } from '../types.js';
import type { RunnerEvent } from '../../../runner/types.js';

export const pushNode: BlueprintNode = {
  name: 'push',
  kind: 'deterministic',
  async *run(ctx: BlueprintContext, deps: NodeDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'pushing branch…' };
    await deps.gitNodes.push({
      lease: ctx.lease,
      repo: ctx.repo,
      branch: ctx.branch,
      workdir: ctx.workdir,
      volume: ctx.volume,
    });
  },
};
