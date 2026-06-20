/**
 * CloneService interface — the gateway-side seam for performing credentialed
 * git clones on behalf of the agent (the credential never enters the agent env).
 *
 * The interface lives in src/runner/ so docker.ts can import it without a
 * circular dep. The real implementation (RealCloneService) lives in src/oneshot/.
 */

export interface CloneServiceRequest {
  repo: string;
  volume: string;
}

export type CloneOutcome =
  | { ok: true; workdir: string }
  | { ok: false; error: string };

export interface CloneService {
  clone(req: CloneServiceRequest): Promise<CloneOutcome>;
}
