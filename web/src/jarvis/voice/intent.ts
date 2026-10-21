/* Spoken confirmation of a pending draft. Only short, unambiguous
   utterances count; anything else goes to the assistant as a normal turn.
   The model itself can never send: these map to the same confirm/cancel
   endpoints as the card's buttons. */

import { stripWakePhrase } from "../wake/wakeText";

export type DraftIntent = "confirm" | "cancel";

const CONFIRM = new RegExp(
  "^(?:(?:yes|yeah|yep|ok|okay|sure)\\s+)?(?:please\\s+)?" +
  "(?:send(?:\\s+(?:it|that|this|the\\s+(?:message|draft)))?(?:\\s+now)?|confirm(?:\\s+(?:it|that))?|go\\s+ahead(?:\\s+and\\s+send(?:\\s+it)?)?|ship\\s+it)" +
  "(?:\\s+please)?$",
);
const CANCEL = new RegExp(
  "^(?:no\\s+)?(?:please\\s+)?" +
  "(?:cancel(?:\\s+(?:it|that|this|the\\s+(?:message|draft)))?|(?:don't|dont|do\\s+not)\\s+send(?:\\s+(?:it|that|this))?|never\\s*mind|discard(?:\\s+(?:it|that))?|scrap\\s+(?:it|that))" +
  "(?:\\s+please)?$",
);

export function normalizeUtterance(text: string): string {
  return stripWakePhrase(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "send it" / "yes, send it" / "confirm" → confirm; "cancel" / "don't send" → cancel. */
export function draftIntent(text: string): DraftIntent | null {
  const t = normalizeUtterance(text);
  if (!t || t.split(" ").length > 6) return null;
  if (CANCEL.test(t)) return "cancel";
  if (CONFIRM.test(t)) return "confirm";
  return null;
}
