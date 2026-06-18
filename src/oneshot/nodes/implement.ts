import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

export const implementNode: OneShotNode = {
  name: 'implement',
  kind: 'agentic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'implementing…' };

    let innerError: string | null = null;

    const directive =
      `The repository is cloned at ${ctx.workdir} on branch ${ctx.branch}. ` +
      `Make all file changes inside that directory and commit them there with git before finishing.\n\n` +
      ctx.instruction;

    for await (const ev of deps.inner.send(directive)) {
      if (ev.type === 'status') {
        yield { type: 'status', text: ev.text };
      } else if (ev.type === 'text') {
        ctx.implementSummary = ev.text;
      } else if (ev.type === 'error') {
        innerError = ev.message;
        // Treat inner agent error as a blueprint failure — break and handle below
        break;
      }
      // file events from inner runner are not forwarded in this minimal blueprint
    }

    if (innerError !== null) {
      throw new Error(`Inner agent error: ${innerError}`);
    }
  },
};
