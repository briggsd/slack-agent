import type { CredentialBroker, CredentialLease } from '../broker/types.js';
import { providerFor, type FetchFn } from './git-host.js';
import type { PrState, PrStateReader } from '../sessions/pr-state-reader.js';

export class RealPrStateReader implements PrStateReader {
  constructor(
    private readonly broker: CredentialBroker,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async getState(req: { repo: string; number: number }): Promise<PrState> {
    let lease: CredentialLease | undefined;
    try {
      // A multi-host reader would need a host column on pull_requests.
      lease = await this.broker.lease({
        host: 'github',
        repo: req.repo,
        taskId: `pr-reconcile:${req.repo}#${req.number}`,
      });
      return await providerFor('github').getChangeRequestState({
        repo: req.repo,
        number: req.number,
        token: lease.token,
        fetchFn: this.fetchFn,
      });
    } finally {
      await lease?.revoke();
    }
  }
}
