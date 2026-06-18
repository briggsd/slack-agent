import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const cloneNode: OneShotNode = {
  name: 'clone',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'cloning repository…' };
    await deps.gitNodes.clone({
      lease: ctx.lease,
      repo: ctx.repo,
      workdir: ctx.workdir,
      volume: ctx.volume,
    });
  },
};
