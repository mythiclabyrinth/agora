/** Helpers for the thread composer's sticky "require agent" toggle.
 *  Persistence stores only the *on* conversation keys (absence = off) as an
 *  LRU list so the blob stays bounded across installs. */

/** Cap on remembered "on" thread keys (newest first). */
export const REQUIRE_AGENT_MAX = 200;

/** Move `key` to the front of the on-list, capping at REQUIRE_AGENT_MAX. */
export function enableRequireAgent(keys: string[], key: string): string[] {
  return [key, ...keys.filter((k) => k !== key)].slice(0, REQUIRE_AGENT_MAX);
}

/** Drop `key` from the on-list. */
export function disableRequireAgent(keys: string[], key: string): string[] {
  return keys.filter((k) => k !== key);
}

/** Defensive parse of a persisted on-list (drops non-strings, caps length). */
export function parseRequireAgentKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .slice(0, REQUIRE_AGENT_MAX);
}
