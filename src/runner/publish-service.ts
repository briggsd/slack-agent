/**
 * PublishService interface — the gateway-side seam for publishing a verified local
 * candidate on behalf of the agent (the credential never enters the agent env).
 *
 * The interface lives in src/runner/ so docker.ts can import it without a circular dep.
 * The real implementation (RealPublishService) lives in src/oneshot/.
 */

export interface PublishServiceRequest {
  repo: string;
  volume: string;
  title?: string;
  body?: string;
}

export type PublishOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

export interface PublishService {
  publish(req: PublishServiceRequest): Promise<PublishOutcome>;
}
