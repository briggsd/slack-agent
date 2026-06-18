import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const branchNode: OneShotNode = {
  name: 'branch',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'creating branch…' };
    await deps.gitNodes.branch({
      repo: ctx.repo,
      branch: ctx.branch,
      workdir: ctx.workdir,
      volume: ctx.volume,
    });
  },
};
