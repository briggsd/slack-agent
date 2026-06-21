/**
 * GitNodeExecutor — interface for deterministic, credentialed git operations.
 *
 * These run on the trusted gateway side (never inside the agent sandbox).
 * The real implementation (Docker clone/push + REST open-PR/MR) is S03.
 */

import type { CredentialLease } from '../broker/types.js';
import type { RuntimeCatalogEntry } from '../runner/runtime-provision-service.js';

export interface CloneRequest {
  lease: CredentialLease;
  repo: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
  /** When true, clone with --depth 1 --single-branch (investigation clones). */
  shallow?: boolean;
}

export interface PushRequest {
  lease: CredentialLease;
  repo: string;
  branch: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

export interface VerifyRepoRequest {
  repo: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

export interface OpenChangeRequest {
  lease: CredentialLease;
  repo: string;
  head: string;
  /** Fallback PR base; real executors may resolve the repo's default branch instead. */
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
  /** Process exit code. When `skipped` is true this is normalized to 0 (a skip is not a failure). */
  exitCode: number;
  output: string;
  /**
   * True when no check actually ran — the auto-detect default found no package.json
   * or no matching npm script. A skip is distinct from a pass: nothing was checked.
   * Always false when an operator override command is configured (it always runs).
   */
  skipped: boolean;
}

/**
 * Run the project's lint or test command inside an ephemeral container on the
 * shared volume. No credential is required — checks get no GIT_TOKEN (defense-in-depth
 * on the credential boundary). A non-zero exit is a returned result, not a thrown error:
 * the check ran and reported its outcome; failure is data, not an exception.
 */
export interface CheckRequest {
  kind: 'lint' | 'test';
  /** Repository slug (e.g. "acme/widgets") — used for per-repo command lookup. */
  repo: string;
  workdir: string;
  /** Docker volume name to mount at /workspace (e.g. slackbot-ws-<sanitized-key>). */
  volume: string;
}

export interface ProvisionRuntimeRequest {
  name: string;
  entry: RuntimeCatalogEntry;
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
  /** Verify the local worktree's origin matches `repo`; no credential required. */
  verifyRepo(req: VerifyRepoRequest): Promise<boolean>;
  push(req: PushRequest): Promise<void>;
  openChangeRequest(req: OpenChangeRequest): Promise<{ url: string; number: number; headSha: string }>;
  /**
   * Run the project's lint or test command in an ephemeral container on the volume.
   * No credential is injected (defense-in-depth: the token never reaches lint/test).
   * A non-zero exit resolves with that exitCode — it is a returned result, not a
   * thrown error. Only a true spawn/infrastructure failure rejects the promise.
   */
  runCheck(req: CheckRequest): Promise<CheckResult>;
  /**
   * Install a pinned, relocatable runtime onto the session volume using an
   * ephemeral no-credential container. Idempotent when the runtime bin dir already exists.
   */
  provisionRuntime(req: ProvisionRuntimeRequest): Promise<void>;
}
