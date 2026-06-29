import type {
  IssueData,
  ReadIssueOutcome,
  ReadIssueService,
  ReadIssueServiceRequest,
} from './read-issue-service.js';

/**
 * FakeReadIssueService — test double for ReadIssueService.
 * Records every readIssue() call; scriptable to return ok or failure.
 */
export class FakeReadIssueService implements ReadIssueService {
  public requests: ReadIssueServiceRequest[] = [];
  private nextOutcome: ReadIssueOutcome = {
    ok: true,
    issue: {
      title: 'Fake issue title',
      body: 'Fake issue body',
      state: 'open',
      author: 'fake-author',
      comments: [],
    },
  };

  /** Script the next readIssue() outcome (can set repeatedly). */
  setOutcome(outcome: ReadIssueOutcome): void {
    this.nextOutcome = outcome;
  }

  /** Convenience: set a success outcome with specific issue data. */
  setIssue(issue: IssueData): void {
    this.nextOutcome = { ok: true, issue };
  }

  async readIssue(req: ReadIssueServiceRequest): Promise<ReadIssueOutcome> {
    this.requests.push(req);
    return this.nextOutcome;
  }
}
