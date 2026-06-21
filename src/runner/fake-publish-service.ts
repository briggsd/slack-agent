import type {
  PublishOutcome,
  PublishService,
  PublishServiceRequest,
  PrEditOutcome,
  PrEditServiceRequest,
  PrCommentOutcome,
  PrCommentServiceRequest,
} from './publish-service.js';

/**
 * FakePublishService — test double for PublishService.
 * Records every publish() call; scriptable to return ok or failure.
 */
export class FakePublishService implements PublishService {
  public publishes: PublishServiceRequest[] = [];
  public prEdits: PrEditServiceRequest[] = [];
  public prComments: PrCommentServiceRequest[] = [];
  private nextOutcome: PublishOutcome = {
    ok: true,
    prUrl: 'https://example.test/pr/1',
    prNumber: 1,
    headSha: 'fake-head-sha',
  };
  private nextEditOutcome: PrEditOutcome = {
    ok: true,
    prUrl: 'https://example.test/pr/1',
  };
  private nextCommentOutcome: PrCommentOutcome = {
    ok: true,
    prUrl: 'https://example.test/pr/1',
  };

  /** Script the next publish() outcome (can set repeatedly). */
  setOutcome(outcome: PublishOutcome): void {
    this.nextOutcome = outcome;
  }

  /** Script the next editPr() outcome (can set repeatedly). */
  setEditOutcome(outcome: PrEditOutcome): void {
    this.nextEditOutcome = outcome;
  }

  /** Script the next commentPr() outcome (can set repeatedly). */
  setCommentOutcome(outcome: PrCommentOutcome): void {
    this.nextCommentOutcome = outcome;
  }

  async publish(req: PublishServiceRequest): Promise<PublishOutcome> {
    this.publishes.push(req);
    return this.nextOutcome;
  }

  async editPr(req: PrEditServiceRequest): Promise<PrEditOutcome> {
    this.prEdits.push(req);
    return this.nextEditOutcome;
  }

  async commentPr(req: PrCommentServiceRequest): Promise<PrCommentOutcome> {
    this.prComments.push(req);
    return this.nextCommentOutcome;
  }
}
