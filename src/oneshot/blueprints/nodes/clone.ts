import type { BlueprintNode, BlueprintContext, NodeDeps } from '../types.js';
import type { RunnerEvent } from '../../../runner/types.js';

export const cloneNode: BlueprintNode = {
  name: 'clone',
  kind: 'deterministic',
  async *run(ctx: BlueprintContext, deps: NodeDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'cloning repository…' };
    await deps.gitNodes.clone({
      lease: ctx.lease,
      repo: ctx.repo,
      workdir: ctx.workdir,
      volume: ctx.volume,
    });
  },
};
