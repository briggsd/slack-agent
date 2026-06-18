import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const lintNode: OneShotNode = {
  name: 'lint',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'linting…' };
    const result = await deps.gitNodes.runCheck({ kind: 'lint', workdir: ctx.workdir, volume: ctx.volume });
    ctx.lintResult = result;
    if (result.exitCode === 0) {
      yield { type: 'status', text: 'lint passed' };
    } else {
      yield { type: 'status', text: 'lint failed (surfaced; not blocking until the retry loop lands)' };
    }
  },
};
