import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const pushNode: OneShotNode = {
  name: 'push',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
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
