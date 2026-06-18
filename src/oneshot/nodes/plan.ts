import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';
import { runAgenticTurn } from './agentic-turn.js';

export const planNode: OneShotNode = {
  name: 'plan',
  kind: 'agentic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'planning…' };

    const prompt =
      `Based on your research of the repository, write a concise implementation plan for the task. ` +
      `List the specific files to create or modify and describe the changes needed. ` +
      `Do NOT make any changes yet; this is the planning phase only.`;

    yield* runAgenticTurn(deps, prompt, (text) => {
      ctx.planSummary = text;
    });
  },
};
