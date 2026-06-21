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
  | { ok: true; prUrl: string; prNumber: number; headSha: string }
  | { ok: false; reason: string };

export interface PrEditServiceRequest {
  repo: string;
  volume: string;
  title?: string;
  body?: string;
}

export type PrEditOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

export interface PrCommentServiceRequest {
  repo: string;
  volume: string;
  comment: string;
}

export type PrCommentOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

export interface PublishService {
  publish(req: PublishServiceRequest): Promise<PublishOutcome>;
  editPr(req: PrEditServiceRequest): Promise<PrEditOutcome>;
  commentPr(req: PrCommentServiceRequest): Promise<PrCommentOutcome>;
}
