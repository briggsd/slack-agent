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
 * Create a local branch in the cloned working tree — purely local, no credential
 * required. The shared volume ensures the agent container sees the new branch
 * on startup (same coordination mechanism as clone→implement handoff).
 */
export interface BranchRequest {
  repo: string;
  branch: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

/** The captured result of running a lint or test check inside an ephemeral container. */
export interface CheckResult {
  exitCode: number;
  output: string;
}

/**
 * Run the project's lint or test command inside an ephemeral container on the
 * shared volume. No credential is required — checks get no GIT_TOKEN (defense-in-depth
 * on the credential boundary). A non-zero exit is a returned result, not a thrown error:
 * the check ran and reported its outcome; failure is data, not an exception.
 */
export interface CheckRequest {
  kind: 'lint' | 'test';
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

/**
 * Deterministic, credentialed git operations. Run trusted-side; never in the
 * agent sandbox.
 */
export interface GitNodeExecutor {
  clone(req: CloneRequest): Promise<void>;
  /** Create a local branch; no credential needed (purely local git op). */
  branch(req: BranchRequest): Promise<void>;
  push(req: PushRequest): Promise<void>;
  openChangeRequest(req: OpenChangeRequest): Promise<{ url: string }>;
  /**
   * Run the project's lint or test command in an ephemeral container on the volume.
   * No credential is injected (defense-in-depth: the token never reaches lint/test).
   * A non-zero exit resolves with that exitCode — it is a returned result, not a
   * thrown error. Only a true spawn/infrastructure failure rejects the promise.
   */
  runCheck(req: CheckRequest): Promise<CheckResult>;
}
