import type { OneShotAgenticNode, OneShotAgenticContext, OneShotDeps } from '../context.js';
import type { RunnerEvent, GateResume } from '../../runner/types.js';

/**
 * Plan-approval gate (supervised one-shot only).
 *
 * Deterministic — it calls no agent; it runs gateway-side, parks the run with an
 * `await_approval` event carrying the plan, and reads back the human's reply.
 * Typed against the lease-free {@link OneShotAgenticContext}: the gate never needs
 * (and must not see) the credential lease.
 *
 * Reply handling (whole message, trimmed + lowercased):
 *   - `approve` / `approved`           → set planApproved (the loop combinator exits → implement)
 *   - `cancel` / `abort` / `reject`    → abandon the run (yield `abandoned`)
 *   - timeout (or a missing resume)    → abandon the run (yield `abandoned`)
 *   - anything else                    → record as planFeedback; the loop re-plans with it
 *
 * Abandon is a deliberate, non-error end of the run: it yields an `abandoned` event the
 * gateway renders cleanly and then stops driving the generator, which unwinds the
 * orchestrator's lease-revoke `finally`. (The gate never reaches the branch/push/PR nodes.)
 */

const APPROVE = new Set(['approve', 'approved']);
const CANCEL = new Set(['cancel', 'abort', 'reject']);

/** Plan text is posted to Slack; cap it so the gate prompt stays a sane size. */
const GATE_PROMPT_MAX_CHARS = 2800;

function buildGatePrompt(planSummary: string | undefined): string {
  const plan =
    planSummary !== undefined && planSummary.trim() !== ''
      ? planSummary
      : '(no plan was produced)';
  const capped =
    plan.length > GATE_PROMPT_MAX_CHARS
      ? `${plan.slice(0, GATE_PROMPT_MAX_CHARS)}\n…(truncated)`
      : plan;
  return (
    `${capped}\n\n---\n` +
    'Reply `approve` (or `approved`) to proceed as planned, or `cancel` to abandon. ' +
    "Any other reply is treated as requested changes — I'll revise the plan and ask again."
  );
}

export const planGateNode: OneShotAgenticNode = {
  name: 'plan-gate',
  kind: 'deterministic',
  async *run(ctx: OneShotAgenticContext, _deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    // Park: yield the plan + vocabulary, read back the gateway's resume value.
    const resume: GateResume | undefined = yield {
      type: 'await_approval',
      prompt: buildGatePrompt(ctx.planSummary),
    };

    // No reply within the gate window (or, defensively, no resume fed at all) → abandon.
    if (resume === undefined || resume.kind === 'timeout') {
      yield { type: 'abandoned', reason: 'timed out' };
      return;
    }

    const norm = resume.text.trim().toLowerCase();

    if (APPROVE.has(norm)) {
      ctx.planApproved = true;
      return;
    }

    if (CANCEL.has(norm)) {
      yield { type: 'abandoned', reason: 'cancelled' };
      return;
    }

    // Treat everything else as feedback. Store the RAW reply; the plan node delimits it as
    // data when folding it into the revised plan (it is untrusted user text, not instructions).
    ctx.planFeedback = resume.text;
  },
};
