import type { OneShotAgenticNode, OneShotAgenticContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';
import { runAgenticTurn } from './agentic-turn.js';

export const researchNode: OneShotAgenticNode = {
  name: 'research',
  kind: 'agentic',
  async *run(ctx: OneShotAgenticContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'researching…' };

    const prompt =
      `You are about to work on the repository cloned at ${ctx.workdir}. ` +
      `Investigate the repository thoroughly — its structure, conventions, relevant files, ` +
      `and anything pertinent to the task described below. ` +
      `Do NOT make any changes yet; this is the research phase only.\n\n` +
      `Task: ${ctx.instruction}`;

    yield* runAgenticTurn(deps, prompt, (text) => {
      ctx.researchSummary = text;
    });
  },
};
