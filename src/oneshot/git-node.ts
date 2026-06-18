/**
 * GitNodeExecutor — interface for deterministic, credentialed git operations.
 *
 * These run on the trusted gateway side (never inside the agent sandbox).
 * The real implementation (Docker clone/push + REST open-PR/MR) is S03.
 */

import type { CredentialLease } from '../broker/types.js';

export interface CloneRequest {
  lease: CredentialLease;
  repo: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

export interface PushRequest {
  lease: CredentialLease;
  repo: string;
  branch: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

export interface OpenChangeRequest {
  lease: CredentialLease;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

/**
 * Deterministic, credentialed git operations. Run trusted-side; never in the
 * agent sandbox.
 */
export interface GitNodeExecutor {
  clone(req: CloneRequest): Promise<void>;
  push(req: PushRequest): Promise<void>;
  openChangeRequest(req: OpenChangeRequest): Promise<{ url: string }>;
}
