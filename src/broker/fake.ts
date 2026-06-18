import type {
  LeaseRequest,
  CredentialLease,
  CredentialBroker,
} from './types.js';

/**
 * FakeBroker — a test double for CredentialBroker.
 *
 * Records every lease and revoke request so tests can assert the broker
 * was called as expected. Mirrors FakeRunnerFactory in style.
 */
export class FakeBroker implements CredentialBroker {
  public leases: LeaseRequest[] = [];
  public revokes: LeaseRequest[] = [];
  private token: string;

  constructor(token = 'fake-token') {
    this.token = token;
  }

  async lease(req: LeaseRequest): Promise<CredentialLease> {
    this.leases.push(req);
    const token = this.token;
    const revokes = this.revokes;

    return {
      token,
      host: req.host,
      repo: req.repo,
      revoke: async () => {
        revokes.push(req);
      },
    };
  }
}
