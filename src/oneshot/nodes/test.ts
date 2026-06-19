import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const testNode: OneShotNode = {
  name: 'test',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'testing…' };
    const result = await deps.gitNodes.runCheck({ kind: 'test', repo: ctx.repo, workdir: ctx.workdir, volume: ctx.volume });
    ctx.testResult = result;
    if (result.skipped) {
      yield { type: 'status', text: 'tests skipped (no command)' };
    } else if (result.exitCode === 0) {
      yield { type: 'status', text: 'tests passed' };
    } else {
      yield { type: 'status', text: 'tests failed (surfaced; not blocking until the retry loop lands)' };
    }
  },
};
