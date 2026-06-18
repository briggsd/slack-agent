/**
 * Profile registry — the seam for future per-thread behaviour bundles.
 *
 * This slice (M4 S02) introduces the minimal shape and one entry. Facets
 * (system prompt, tool policy, network/resource isolation) are added in later
 * slices once the protocol supports them.
 *
 * M5 S02 adds `mode` to distinguish conversational sessions from one-shot
 * repo tasks.
 */

export interface Profile {
  id: string;
  label: string;
  mode: 'conversational' | 'one-shot';
}

export const PROFILES: ReadonlyMap<string, Profile> = new Map([
  ['conversational', { id: 'conversational', label: 'Conversational', mode: 'conversational' }],
  ['repo-oneshot', { id: 'repo-oneshot', label: 'Repo (one-shot)', mode: 'one-shot' }],
]);

export const DEFAULT_PROFILE_ID = 'conversational';
export const REPO_ONESHOT_PROFILE_ID = 'repo-oneshot';

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
