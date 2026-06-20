/**
 * CheckService interface — the gateway-side seam for running deterministic
 * project checks on a verified local candidate. Checks receive no credentials.
 *
 * The interface lives in src/runner/ so docker.ts can import it without a circular dep.
 * The real implementation (RealCheckService) lives in src/oneshot/.
 */

import type { CheckKind, RunChecksKind, RunChecksResult } from './protocol.js';

export type { CheckKind, RunChecksKind, RunChecksResult };

export interface CheckServiceRequest {
  repo: string;
  volume: string;
  kind?: RunChecksKind;
}

export type CheckOutcome =
  | { ok: true; results: RunChecksResult[] }
  | { ok: false; reason: string };

export interface CheckService {
  runChecks(req: CheckServiceRequest): Promise<CheckOutcome>;
}
