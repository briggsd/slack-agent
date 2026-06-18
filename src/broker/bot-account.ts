import type {
  GitHost,
  LeaseRequest,
  CredentialLease,
  CredentialBroker,
} from './types.js';

/**
 * BotAccountBroker — a credential broker using static per-host bot-account tokens.
 *
 * This interim provider leases the same immutable token for every request to a
 * given host. Unlike short-lived tokens minted per task (future GitLab/GitHub
 * App approach), the static token has no per-task lifecycle — `revoke()` is a
 * no-op. The protection that holds is that the token never reaches the agent
 * sandbox; it stays on the trusted gateway side and is only passed to
 * deterministic git operations (clone, push). A breach of the sandbox cannot
 * exfiltrate the token.
 */
export class BotAccountBroker implements CredentialBroker {
  private tokens: ReadonlyMap<GitHost, string>;

  constructor(tokens: ReadonlyMap<GitHost, string>) {
    this.tokens = tokens;
  }

  async lease(req: LeaseRequest): Promise<CredentialLease> {
    const token = this.tokens.get(req.host);
    if (token === undefined) {
      throw new Error(`no bot-account token configured for host "${req.host}"`);
    }

    return {
      token,
      host: req.host,
      repo: req.repo,
      revoke: async () => {
        // Static token has no per-task lifecycle — no-op.
      },
    };
  }
}
