/** A git host the broker can lease credentials for. Open set; gitlab is the planned second. */
export type GitHost = 'github' | 'gitlab';

/** A request to lease a credential for one task, scoped to a host + repo. */
export interface LeaseRequest {
  host: GitHost;
  /** "org/name" slug. */
  repo: string;
  /** Correlates the lease with the one-shot task that owns it (audit trail, M6). */
  taskId: string;
}

/**
 * A leased credential. Handed only to trusted-side deterministic git nodes
 * (never to the agent sandbox). `revoke()` ends the lease — a real revoke for
 * short-lived App tokens (future), a no-op for a static interim bot-account token.
 */
export interface CredentialLease {
  readonly token: string;
  readonly host: GitHost;
  readonly repo: string;
  revoke(): Promise<void>;
}

/** Leases per-task git credentials on the trusted side. */
export interface CredentialBroker {
  lease(req: LeaseRequest): Promise<CredentialLease>;
}
