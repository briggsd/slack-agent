import type {
  DecisionToGrade,
  ListDecisionsToGradeOptions,
  SessionStore,
} from '../sessions/store.js';

export interface GradeResult {
  verdict: 'clear' | 'thin' | 'opaque';
  gaps: string;
}

export type GradeFn = (decision: DecisionToGrade) => Promise<GradeResult>;

export interface GradeRunSummary {
  graded: number;
  failed: number;
  verdicts: {
    clear: number;
    thin: number;
    opaque: number;
  };
}

export async function gradeDecisions(deps: {
  store: SessionStore;
  grade: GradeFn;
  now?: () => number;
  sinceMs?: number;
  limit?: number;
}): Promise<GradeRunSummary> {
  const now = deps.now ?? (() => Date.now());
  const summary: GradeRunSummary = {
    graded: 0,
    failed: 0,
    verdicts: {
      clear: 0,
      thin: 0,
      opaque: 0,
    },
  };
  const opts: ListDecisionsToGradeOptions = {
    ...(deps.sinceMs !== undefined ? { sinceMs: deps.sinceMs } : {}),
    ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
  };
  const decisions = deps.store.listDecisionsToGrade(opts);

  for (const decision of decisions) {
    try {
      const result = await deps.grade(decision);
      deps.store.recordAudit({
        session_key: decision.session_key,
        team_id: decision.team_id,
        user_id: null,
        profile_id: decision.profile_id,
        ts: now(),
        kind: 'comprehension',
        tool: 'comprehension',
        summary: null,
        reasoning: result.gaps,
        result: result.verdict,
        cost_tokens: null,
        cost_micro_usd: null,
        durations_ms: null,
        graded_audit_id: decision.id,
      });
      summary.graded += 1;
      summary.verdicts[result.verdict] += 1;
    } catch {
      summary.failed += 1;
      console.error(
        `[comprehension] failed decision_id=${decision.id} session_key=${decision.session_key}`,
      );
    }
  }

  return summary;
}
