import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSessionStore } from '../src/sessions/store.js';
import { gradeDecisions } from '../src/telemetry/grade-decisions.js';

describe('gradeDecisions', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = new SqliteSessionStore(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  function recordDecision(params: {
    sessionKey: string;
    teamId: string | null;
    profileId: string | null;
    ts: number;
    tool?: string | null;
    result?: string | null;
    reasoning: string;
  }): void {
    store.recordAudit({
      session_key: params.sessionKey,
      team_id: params.teamId,
      user_id: null,
      profile_id: params.profileId,
      ts: params.ts,
      kind: 'decision',
      tool: params.tool ?? 'verify',
      summary: null,
      reasoning: params.reasoning,
      result: params.result ?? 'pass',
      cost_tokens: null,
      cost_micro_usd: null,
      durations_ms: null,
      graded_audit_id: null,
    });
  }

  it('writes one comprehension audit row per ungraded decision and links graded_audit_id', async () => {
    recordDecision({
      sessionKey: 'TEAM:C:TS',
      teamId: 'TEAM',
      profileId: 'repo-oneshot',
      ts: 1_000,
      reasoning: 'Cites the spec and explains why the checks are sufficient.',
    });
    const [decision] = store.listDecisionsToGrade({});
    expect(decision).toBeDefined();

    const summary = await gradeDecisions({
      store,
      now: () => 9_999,
      grade: async () => ({
        verdict: 'thin',
        gaps: 'Mentions the checks but does not call out rollback risk.',
      }),
    });

    expect(summary).toEqual({
      graded: 1,
      failed: 0,
      verdicts: {
        clear: 0,
        thin: 1,
        opaque: 0,
      },
    });

    expect(store.getAuditEvents('TEAM:C:TS')).toEqual([
      {
        session_key: 'TEAM:C:TS',
        team_id: 'TEAM',
        user_id: null,
        profile_id: 'repo-oneshot',
        ts: 1_000,
        kind: 'decision',
        tool: 'verify',
        summary: null,
        reasoning: 'Cites the spec and explains why the checks are sufficient.',
        result: 'pass',
        cost_tokens: null,
        cost_micro_usd: null,
        durations_ms: null,
        graded_audit_id: null,
      },
      {
        session_key: 'TEAM:C:TS',
        team_id: 'TEAM',
        user_id: null,
        profile_id: 'repo-oneshot',
        ts: 9_999,
        kind: 'comprehension',
        tool: 'comprehension',
        summary: null,
        reasoning: 'Mentions the checks but does not call out rollback risk.',
        result: 'thin',
        cost_tokens: null,
        cost_micro_usd: null,
        durations_ms: null,
        graded_audit_id: decision?.id ?? null,
      },
    ]);
  });

  it('is idempotent across re-runs because previously graded decisions are excluded', async () => {
    recordDecision({
      sessionKey: 'TEAM:C:ONE',
      teamId: 'TEAM',
      profileId: 'conversational',
      ts: 1_000,
      reasoning: 'Explains the chosen path and failure mode.',
    });
    const grade = vi.fn(async () => ({
      verdict: 'clear' as const,
      gaps: 'No material gaps.',
    }));

    const first = await gradeDecisions({
      store,
      now: () => 2_000,
      grade,
    });
    const second = await gradeDecisions({
      store,
      now: () => 3_000,
      grade,
    });

    expect(first).toEqual({
      graded: 1,
      failed: 0,
      verdicts: {
        clear: 1,
        thin: 0,
        opaque: 0,
      },
    });
    expect(second).toEqual({
      graded: 0,
      failed: 0,
      verdicts: {
        clear: 0,
        thin: 0,
        opaque: 0,
      },
    });
    expect(grade).toHaveBeenCalledTimes(1);
    expect(store.getAuditEvents('TEAM:C:ONE').filter((row) => row.kind === 'comprehension')).toHaveLength(1);
  });

  it('logs and skips a grade failure while continuing with later decisions', async () => {
    recordDecision({
      sessionKey: 'TEAM:C:FAIL',
      teamId: 'TEAM',
      profileId: 'repo-oneshot',
      ts: 1_000,
      reasoning: 'first rationale should fail grading',
    });
    recordDecision({
      sessionKey: 'TEAM:C:PASS',
      teamId: 'TEAM',
      profileId: 'repo-oneshot',
      ts: 2_000,
      reasoning: 'second rationale should still be graded',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await gradeDecisions({
      store,
      now: () => 5_000,
      grade: async (decision) => {
        if (decision.session_key === 'TEAM:C:FAIL') {
          throw new Error('simulated grader failure');
        }
        return {
          verdict: 'opaque',
          gaps: 'Does not explain why this branch is safe.',
        };
      },
    });

    expect(summary).toEqual({
      graded: 1,
      failed: 1,
      verdicts: {
        clear: 0,
        thin: 0,
        opaque: 1,
      },
    });
    expect(store.getAuditEvents('TEAM:C:FAIL').filter((row) => row.kind === 'comprehension')).toHaveLength(0);
    expect(store.getAuditEvents('TEAM:C:PASS').filter((row) => row.kind === 'comprehension')).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain('decision_id=');
    expect(String(message)).toContain('session_key=TEAM:C:FAIL');
    expect(String(message)).not.toContain('first rationale should fail grading');
  });
});
