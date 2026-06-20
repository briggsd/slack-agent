import type { CheckOutcome, CheckService, CheckServiceRequest } from './check-service.js';

/**
 * FakeCheckService — test double for CheckService.
 * Records every runChecks() call; scriptable to return ok or failure.
 */
export class FakeCheckService implements CheckService {
  public checks: CheckServiceRequest[] = [];
  private nextOutcome: CheckOutcome = {
    ok: true,
    results: [
      { kind: 'lint', exitCode: 0, skipped: false, output: '' },
      { kind: 'test', exitCode: 0, skipped: false, output: '' },
    ],
  };

  /** Script the next runChecks() outcome (can set repeatedly). */
  setOutcome(outcome: CheckOutcome): void {
    this.nextOutcome = outcome;
  }

  async runChecks(req: CheckServiceRequest): Promise<CheckOutcome> {
    this.checks.push(req);
    return this.nextOutcome;
  }
}
