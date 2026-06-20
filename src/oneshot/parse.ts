/**
 * parseOneShotTask — parses the minimal one-shot task grammar.
 *
 * Grammar: "<host>:<owner>/<repo>" followed by whitespace then the instruction.
 * Example: "github:acme/widgets add a CHANGELOG"
 *
 * Returns a parsed result on success, or null on a malformed message or
 * unknown host.
 */

import type { GitHost } from '../broker/types.js';

const KNOWN_HOSTS: readonly GitHost[] = ['github', 'gitlab'];

export interface ParsedOneShotTask {
  host: GitHost;
  /** "owner/name" slug */
  repo: string;
  instruction: string;
}

/**
 * A repo slug segment: alphanumerics, dot, underscore, hyphen. Each path segment
 * must match this — and must not be `.` or `..`, which would let a crafted repo
 * slug escape its workspace directory once it is used to build a filesystem path
 * (the slug comes from untrusted user input).
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** True iff `repo` is a safe `owner/name` (or GitLab `group/sub/name`) slug — no traversal.
 *  Exported so paths that bypass {@link parseOneShotTask} (e.g. the orchestrator's
 *  explicit-context build tail) can re-apply the same no-traversal guarantee. */
export function isSafeRepoSlug(repo: string): boolean {
  const segments = repo.split('/');
  // At least owner + name.
  if (segments.length < 2) {
    return false;
  }
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a one-shot task message.
 * Returns the parsed task on success, or null on failure.
 */
export function parseOneShotTask(message: string): ParsedOneShotTask | null {
  // Match "<host>:<repo>" (both non-greedy, no spaces) then whitespace + the instruction.
  const match = /^(\S+?):(\S+?)\s+(.+)$/s.exec(message.trim());
  if (match === null) {
    return null;
  }

  const rawHost = match[1];
  const repo = match[2];
  const instruction = match[3]?.trim() ?? '';

  if (rawHost === undefined || repo === undefined || instruction === '') {
    return null;
  }

  if (!(KNOWN_HOSTS as readonly string[]).includes(rawHost)) {
    return null;
  }

  // Reject anything that isn't a clean owner/name slug — blocks path traversal
  // when the slug is later used to build the clone workdir.
  if (!isSafeRepoSlug(repo)) {
    return null;
  }

  return {
    host: rawHost as GitHost,
    repo,
    instruction,
  };
}
