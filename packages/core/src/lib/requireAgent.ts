/** Helpers for the thread composer's sticky "require agent" toggle.
 *  The toggle is ON by default: an untagged thread reply is context agents
 *  listen to, not a prompt they answer. Persistence therefore stores only the
 *  *exceptions* — conversation keys the user switched OFF — as an LRU list so
 *  the blob stays bounded across installs. */

/** Cap on remembered "off" thread keys (newest first). */
export const REQUIRE_AGENT_MAX = 200;

/** The toggle's value for a conversation with no stored exception. */
export const REQUIRE_AGENT_DEFAULT = true;

/** Is the toggle on for `key`? On unless an exception says otherwise. */
export function isRequireAgentOn(offKeys: string[], key: string): boolean {
  return !offKeys.includes(key);
}

/** Move `key` to the front of the off-list, capping at REQUIRE_AGENT_MAX. */
export function rememberRequireAgentOff(keys: string[], key: string): string[] {
  return [key, ...keys.filter((k) => k !== key)].slice(0, REQUIRE_AGENT_MAX);
}

/** Drop `key` from the off-list (back to the ON default). */
export function forgetRequireAgentOff(keys: string[], key: string): string[] {
  return keys.filter((k) => k !== key);
}

/** Defensive parse of a persisted off-list (drops non-strings, caps length). */
export function parseRequireAgentKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .slice(0, REQUIRE_AGENT_MAX);
}
