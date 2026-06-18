import type { BlueprintNode, BlueprintContext, NodeDeps } from '../types.js';
import type { RunnerEvent } from '../../../runner/types.js';

export const implementNode: BlueprintNode = {
  name: 'implement',
  kind: 'agentic',
  async *run(ctx: BlueprintContext, deps: NodeDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'implementing…' };

    let innerError: string | null = null;

    for await (const ev of deps.inner.send(ctx.instruction)) {
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
