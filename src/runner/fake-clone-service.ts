import type { CloneService, CloneServiceRequest, CloneOutcome } from './clone-service.js';

/**
 * FakeCloneService — test double for CloneService.
 * Records every clone() call; scriptable to return ok or failure.
 */
export class FakeCloneService implements CloneService {
  public clones: CloneServiceRequest[] = [];
  private nextOutcome: CloneOutcome = { ok: true, workdir: '/workspace/owner-repo' };

  /** Script the next clone() outcome (can set repeatedly). */
  setOutcome(outcome: CloneOutcome): void {
    this.nextOutcome = outcome;
  }

  async clone(req: CloneServiceRequest): Promise<CloneOutcome> {
    this.clones.push(req);
    return this.nextOutcome;
  }
}
