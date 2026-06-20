import type { PublishOutcome, PublishService, PublishServiceRequest } from './publish-service.js';

/**
 * FakePublishService — test double for PublishService.
 * Records every publish() call; scriptable to return ok or failure.
 */
export class FakePublishService implements PublishService {
  public publishes: PublishServiceRequest[] = [];
  private nextOutcome: PublishOutcome = { ok: true, prUrl: 'https://example.test/pr/1' };

  /** Script the next publish() outcome (can set repeatedly). */
  setOutcome(outcome: PublishOutcome): void {
    this.nextOutcome = outcome;
  }

  async publish(req: PublishServiceRequest): Promise<PublishOutcome> {
    this.publishes.push(req);
    return this.nextOutcome;
  }
}
