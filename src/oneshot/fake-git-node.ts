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
  OpenChangeRequest,
} from './git-node.js';

export class FakeGitNodeExecutor implements GitNodeExecutor {
  public clones: CloneRequest[] = [];
  public branches: BranchRequest[] = [];
  public pushes: PushRequest[] = [];
  public changeRequests: OpenChangeRequest[] = [];

  private readonly prUrl: string;
  private branchError: Error | null = null;
  private pushError: Error | null = null;
  private openChangeError: Error | null = null;

  constructor(prUrl = 'https://example.test/pr/1') {
    this.prUrl = prUrl;
  }

  /** Script branch() to reject with the given error (for failure-path tests). */
  failNextBranch(err: Error): void {
    this.branchError = err;
  }

  /** Script push() to reject with the given error (for failure-path tests). */
  failNextPush(err: Error): void {
    this.pushError = err;
  }

  /** Script openChangeRequest() to reject with the given error (for failure-path tests). */
  failNextOpenChange(err: Error): void {
    this.openChangeError = err;
  }

  async clone(req: CloneRequest): Promise<void> {
    this.clones.push(req);
  }

  async branch(req: BranchRequest): Promise<void> {
    this.branches.push(req);
    if (this.branchError !== null) {
      const err = this.branchError;
      this.branchError = null;
      throw err;
    }
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
}
