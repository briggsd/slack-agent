/**
 * Profile registry — the seam for future per-thread behaviour bundles.
 *
 * This slice (M4 S02) introduces the minimal shape and one entry. Facets
 * (system prompt, tool policy, network/resource isolation) are added in later
 * slices once the protocol supports them.
 *
 * M5 S02 adds `mode` to distinguish conversational sessions from one-shot
 * repo tasks.
 *
 * M6 S02 adds `planGate` to declare whether the profile's one-shot blueprint
 * includes the plan-approval gate (the gate node itself lands in S03).
 */

export interface Profile {
  id: string;
  label: string;
  mode: 'conversational' | 'one-shot';
  /**
   * Declares that the profile's one-shot blueprint is the supervised variant —
   * it will pause after planning for human approval before implementing. The gate
   * node that actually pauses is inserted in M6 S03; until then this is a marker
   * only and no run parks on it.
   */
  planGate: boolean;
  /**
   * Profile version, stamped onto every session created under it
   * (`sessions.harness_version`) for clean attribution — so a meta-agent can
   * compare outcomes across profile revisions (design/0014 Part A, Q10).
   * Hand-bumped: increment whenever this profile's prompt or tool policy changes.
   */
  version: string;
}

export const PROFILES: ReadonlyMap<string, Profile> = new Map([
  ['conversational', { id: 'conversational', label: 'Conversational', mode: 'conversational', planGate: false, version: '1' }],
  ['repo-oneshot', { id: 'repo-oneshot', label: 'Repo (one-shot)', mode: 'one-shot', planGate: false, version: '1' }],
  ['supervised-repo-oneshot', { id: 'supervised-repo-oneshot', label: 'Repo (supervised one-shot)', mode: 'one-shot', planGate: true, version: '1' }],
]);

export const DEFAULT_PROFILE_ID = 'conversational';
export const REPO_ONESHOT_PROFILE_ID = 'repo-oneshot';
export const SUPERVISED_REPO_ONESHOT_PROFILE_ID = 'supervised-repo-oneshot';

/**
 * Resolve a profile by id.
 * Returns the matching profile when known, or the default profile when the id
 * is unknown. Never throws — an unrecognised id is treated as "use the default"
 * so a stale or mis-configured value degrades gracefully.
 */
export function getProfile(id: string): Profile {
  const profile = PROFILES.get(id);
  if (profile !== undefined) {
    return profile;
  }
  // Unknown id — fall back to default rather than crashing.
  const fallback = PROFILES.get(DEFAULT_PROFILE_ID);
  // This cast is safe: DEFAULT_PROFILE_ID is a key we just defined above.
  return fallback as Profile;
}
