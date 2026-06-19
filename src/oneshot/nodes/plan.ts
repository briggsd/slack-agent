import type { OneShotAgenticNode, OneShotAgenticContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';
import { runAgenticTurn } from './agentic-turn.js';

export const planNode: OneShotAgenticNode = {
  name: 'plan',
  kind: 'agentic',
  async *run(ctx: OneShotAgenticContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'planning…' };

    const prompt =
      `Based on your research of the repository, write a concise implementation plan for the task. ` +
      `List the specific files to create or modify and describe the changes needed. ` +
      `You cannot ask clarifying questions — there is no one to answer. ` +
      `Where the task is ambiguous, choose a reasonable interpretation and record it ` +
      `under an "Assumptions" heading so the pull-request reviewer can see what you decided. ` +
      `Do NOT make any changes yet; this is the planning phase only.`;

    yield* runAgenticTurn(deps, prompt, (text) => {
      ctx.planSummary = text;
    });
  },
};
