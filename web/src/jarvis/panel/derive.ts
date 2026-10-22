/* Pure derived state for the assistant panel, kept out of the component so
   it can be unit tested. */

import { isLiveDraft, type JarvisCardEntry, type JarvisLogEntry } from "../../state/jarvis";

/** The current exchange (from the latest user line on) and the history before it. */
export function splitTurn(log: JarvisLogEntry[]): { history: JarvisLogEntry[]; current: JarvisLogEntry[] } {
  const start = log.reduce((last, item, i) => item.role === "user" ? i : last, 0);
  return { history: log.slice(0, start), current: log.slice(start) };
}

const actionableDraft = (entry: JarvisCardEntry) =>
  isLiveDraft(entry) || (entry.card.kind === "draft" && entry.status === "sending");

/** The newest card plus any draft still awaiting the user stay in view; the
    rest fold under "Earlier results". Order is preserved (newest first). */
export function splitCards(cards: JarvisCardEntry[]): { primary: JarvisCardEntry[]; earlier: JarvisCardEntry[] } {
  const primary = cards.filter((entry, i) => i === 0 || actionableDraft(entry));
  return { primary, earlier: cards.filter(entry => !primary.includes(entry)) };
}
