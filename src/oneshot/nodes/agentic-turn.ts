import type { OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

/**
 * Shared helper for all agentic nodes (research, plan, implement).
 *
 * Sends `prompt` to `deps.inner`, re-yields inner `status` events, passes
 * each inner `text` event to `onText`, and throws on an inner `error` event
 * (message prefixed with "Inner agent error: …"). Non-forwarded event types
 * (e.g. `file`) are silently ignored — file events from the inner runner are
 * not surfaced at this layer.
 */
export async function* runAgenticTurn(
  deps: OneShotDeps,
  prompt: string,
  onText: (text: string) => void,
): AsyncGenerator<RunnerEvent> {
  let innerError: string | null = null;

  for await (const ev of deps.inner.send(prompt)) {
    if (ev.type === 'status') {
      yield { type: 'status', text: ev.text };
    } else if (ev.type === 'text') {
      onText(ev.text);
    } else if (ev.type === 'error') {
      innerError = ev.message;
      break;
    }
    // file events from inner runner are not forwarded in this minimal blueprint
  }

  if (innerError !== null) {
    throw new Error(`Inner agent error: ${innerError}`);
  }
}
