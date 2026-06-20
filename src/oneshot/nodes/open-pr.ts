import type { OneShotNode, OneShotContext, OneShotDeps } from '../context.js';
import type { RunnerEvent } from '../../runner/types.js';

/** Per-section caps so a verbose agent summary can't produce an unbounded PR body. */
const IMPLEMENT_SUMMARY_CAP = 1500;
const PLAN_SUMMARY_CAP = 2000;

/**
 * Cap `text` to `max`, appending a visible marker when content is dropped. The PR
 * body exists to surface the agent's assumptions; a silent mid-sentence cut could
 * read as a complete section while hiding an "Assumptions" block past the cap, so
 * the truncation must be visible to the reviewer.
 */
function capWithMarker(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n_(truncated)_` : text;
}

/**
 * Build the PR body from the agent's own summaries. The implementation summary
 * leads; the plan follows because it carries the "Assumptions" the agent recorded
 * when the task was ambiguous (it cannot ask — see the plan/implement prompts), and
 * the PR is the review gate where that ambiguity must be visible. Falls back to a
 * one-line note when no summary was produced.
 */
export function titleFromInstruction(instruction: string): string {
  return instruction.split('\n')[0]?.slice(0, 72) ?? instruction.slice(0, 72);
}

export function composePrBodyFromParts(input: {
  title: string;
  implementSummary?: string;
  planSummary?: string;
}): string {
  const sections: string[] = [];

  const implementSummary = (input.implementSummary ?? '').trim();
  sections.push(
    implementSummary !== ''
      ? capWithMarker(implementSummary, IMPLEMENT_SUMMARY_CAP)
      : `Automated one-shot implementation.\n\nTask: ${input.title}`,
  );

  const planSummary = (input.planSummary ?? '').trim();
  if (planSummary !== '') {
    sections.push(`## Plan & assumptions\n\n${capWithMarker(planSummary, PLAN_SUMMARY_CAP)}`);
  }

  return sections.join('\n\n');
}

function composePrBody(ctx: OneShotContext, title: string): string {
  return composePrBodyFromParts({
    title,
    ...(ctx.implementSummary !== undefined ? { implementSummary: ctx.implementSummary } : {}),
    ...(ctx.planSummary !== undefined ? { planSummary: ctx.planSummary } : {}),
  });
}

export const openPrNode: OneShotNode = {
  name: 'open-pr',
  kind: 'deterministic',
  async *run(ctx: OneShotContext, deps: OneShotDeps): AsyncGenerator<RunnerEvent> {
    yield { type: 'status', text: 'opening pull request…' };

    // Title: first ~72 chars of the instruction (first line)
    const title = titleFromInstruction(ctx.instruction);
    const body = composePrBody(ctx, title);

    const { url } = await deps.gitNodes.openChangeRequest({
      lease: ctx.lease,
      repo: ctx.repo,
      head: ctx.branch,
      base: 'main',
      title,
      body,
    });

    ctx.prUrl = url;
    // Yield the gateway-internal pr_opened event (not a protocol/wire event). The gateway's
    // drain loop handles it: posts "Opened PR: <url>" to Slack AND records an audit action.
    yield { type: 'pr_opened', url };
  },
};
