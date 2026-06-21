import type {
  ProvisionOutcome,
  RuntimeProvisionRequest,
  RuntimeProvisionService,
} from './runtime-provision-service.js';

/**
 * FakeRuntimeProvisionService — test double for RuntimeProvisionService.
 * Records every provision() call; scriptable to return ok or failure.
 */
export class FakeRuntimeProvisionService implements RuntimeProvisionService {
  public provisions: RuntimeProvisionRequest[] = [];
  private nextOutcome: ProvisionOutcome = { ok: true };

  setOutcome(outcome: ProvisionOutcome): void {
    this.nextOutcome = outcome;
  }

  async provision(req: RuntimeProvisionRequest): Promise<ProvisionOutcome> {
    this.provisions.push(req);
    return this.nextOutcome;
  }
}
