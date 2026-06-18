import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';
import { runAgenticTurn } from './agentic-turn.js';

export const implementNode: OneShotNode = {
  name: 'implement',
  kind: 'agentic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'implementing…' };

    const directive =
      `The repository is cloned at ${ctx.workdir} on branch ${ctx.branch}. ` +
      `Make all file changes inside that directory and commit them there with git before finishing. ` +
      `Implement the plan you produced.\n\n` +
      ctx.instruction;

    yield* runAgenticTurn(deps, directive, (text) => {
      ctx.implementSummary = text;
    });
  },
};
