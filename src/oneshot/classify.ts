/**
 * Heuristic failure classifier for check results.
 *
 * Classifies a combined check output as 'transient' (worth retrying) or
 * 'permanent' (not worth retrying — open the PR with failing checks for review).
 *
 * NOTE: An LLM fallback for ambiguous cases is explicitly deferred to a future
 * slice. The heuristic below covers the most common infrastructure failures.
 */

import type { CheckResult } from './git-node.js';

export type FailureClass = 'transient' | 'permanent';

/**
 * Transient markers — infrastructure failures that are worth retrying:
 * - Timeouts: "timed out", "ETIMEDOUT"
 * - Connection resets: "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "socket hang up"
 * - Network failures (phrased as a failure — a bare "network" mention is NOT enough,
 *   to avoid false-positiving a permanent failure that merely names a "network" module)
 * - Rate / availability: "rate limit", "429", "503", "temporarily unavailable"
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timed out/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /network\s+(error|failure|timeout|unreachable|unavailable)/i,
  /rate limit/i,
  /\b429\b/,
  /\b503\b/,
  /temporarily unavailable/i,
];

/**
 * Returns `'transient'` if the combined check output matches any known transient
 * marker, else `'permanent'`.
 */
export function classifyFailure(output: string): FailureClass {
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(output)) {
      return 'transient';
    }
  }
  return 'permanent';
}

/**
 * Returns true iff `r` exists, is not skipped, and has a non-zero exit code.
 * Shared by the retry decider and the implement feedback section.
 */
export function checkFailed(r: CheckResult | undefined): r is CheckResult {
  return r !== undefined && !r.skipped && r.exitCode !== 0;
}
