/**
 * FakeGitNodeExecutor — test double for GitNodeExecutor.
 *
 * Records every call in order so tests can assert call sequences and
 * arguments. Mirrors FakeRunnerFactory's recording style.
 */

import type {
  GitNodeExecutor,
  CloneRequest,
  BranchRequest,
  PushRequest,
  VerifyRepoRequest,
  OpenChangeRequest,
  CheckRequest,
  CheckResult,
} from './git-node.js';

export class FakeGitNodeExecutor implements GitNodeExecutor {
  public clones: CloneRequest[] = [];
  public branches: BranchRequest[] = [];
  public repoVerifications: VerifyRepoRequest[] = [];
  public pushes: PushRequest[] = [];
  public changeRequests: OpenChangeRequest[] = [];
  public checks: CheckRequest[] = [];

  private readonly prUrl: string;
  private cloneError: Error | null = null;
  private branchError: Error | null = null;
  private verifyRepoResult = true;
  private pushError: Error | null = null;
  private openChangeError: Error | null = null;
  private checkError: Error | null = null;

  /** Fixed fallback result when no queue entry is available. */
  private checkResults: Map<'lint' | 'test', CheckResult> = new Map();
  /**
   * Queue of results per kind. Each call to runCheck pops the first entry;
   * once the queue is empty the last entry (or the fixed fallback) is used.
   */
  private checkQueues: Map<'lint' | 'test', CheckResult[]> = new Map();

  constructor(prUrl = 'https://example.test/pr/1') {
    this.prUrl = prUrl;
  }

  /** Script clone() to reject with the given error (for failure-path tests). */
  failNextClone(err: Error): void {
    this.cloneError = err;
  }

  /** Script branch() to reject with the given error (for failure-path tests). */
  failNextBranch(err: Error): void {
    this.branchError = err;
  }

  /** Script verifyRepo() to return a specific result. */
  setVerifyRepoResult(result: boolean): void {
    this.verifyRepoResult = result;
  }

  /** Script push() to reject with the given error (for failure-path tests). */
  failNextPush(err: Error): void {
    this.pushError = err;
  }

  /** Script openChangeRequest() to reject with the given error (for failure-path tests). */
  failNextOpenChange(err: Error): void {
    this.openChangeError = err;
  }

  /** Script runCheck() to reject with the given error (for infrastructure failure tests). */
  failNextCheck(err: Error): void {
    this.checkError = err;
  }

  /** Script runCheck() to always return a specific result for the given kind. */
  setCheckResult(kind: 'lint' | 'test', result: CheckResult): void {
    this.checkResults.set(kind, result);
  }

  /**
   * Script runCheck() to return successive results for the given kind across
   * multiple calls. Once the queue is drained the last entry sticks (it is
   * repeated for all subsequent calls). Use this when a check should fail on
   * the first cycle and pass on a retry cycle.
   */
  queueCheckResults(kind: 'lint' | 'test', results: CheckResult[]): void {
    this.checkQueues.set(kind, [...results]);
  }

  async clone(req: CloneRequest): Promise<void> {
    this.clones.push(req);
    if (this.cloneError !== null) {
      const err = this.cloneError;
      this.cloneError = null;
      throw err;
    }
  }

  async branch(req: BranchRequest): Promise<void> {
    this.branches.push(req);
    if (this.branchError !== null) {
      const err = this.branchError;
      this.branchError = null;
      throw err;
    }
  }

  async verifyRepo(req: VerifyRepoRequest): Promise<boolean> {
    this.repoVerifications.push(req);
    return this.verifyRepoResult;
  }

  async push(req: PushRequest): Promise<void> {
    this.pushes.push(req);
    if (this.pushError !== null) {
      const err = this.pushError;
      this.pushError = null;
      throw err;
    }
  }

  async openChangeRequest(req: OpenChangeRequest): Promise<{ url: string }> {
    this.changeRequests.push(req);
    if (this.openChangeError !== null) {
      const err = this.openChangeError;
      this.openChangeError = null;
      throw err;
    }
    return { url: this.prUrl };
  }

  async runCheck(req: CheckRequest): Promise<CheckResult> {
    this.checks.push(req);
    if (this.checkError !== null) {
      const err = this.checkError;
      this.checkError = null;
      throw err;
    }

    // Try to pop from the queue first
    const queue = this.checkQueues.get(req.kind);
    if (queue !== undefined && queue.length > 0) {
      // Shift the first entry; if it's the last one, leave it so it sticks
      if (queue.length === 1) {
        return queue[0] as CheckResult;
      }
      return queue.shift() as CheckResult;
    }

    return this.checkResults.get(req.kind) ?? { exitCode: 0, output: '', skipped: false };
  }
}
