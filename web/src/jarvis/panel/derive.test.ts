import { describe, expect, it } from "vitest";
import type { JarvisCardEntry, JarvisLogEntry } from "../../state/jarvis";
import { splitCards, splitTurn } from "./derive";

const line = (id: string, role: JarvisLogEntry["role"]): JarvisLogEntry => ({ id, role, text: id });
const card = (id: string, kind: "digest" | "draft", status?: JarvisCardEntry["status"]) =>
  ({ id, status, card: { kind } }) as unknown as JarvisCardEntry;

describe("splitTurn", () => {
  it("puts the latest user line and what follows in the current exchange", () => {
    const log = [line("u1", "user"), line("a1", "assistant"), line("u2", "user"), line("a2", "assistant")];
    expect(splitTurn(log)).toEqual({ history: log.slice(0, 2), current: log.slice(2) });
  });
  it("treats a log with no user line as all current", () => {
    const log = [line("a1", "assistant")];
    expect(splitTurn(log)).toEqual({ history: [], current: log });
    expect(splitTurn([])).toEqual({ history: [], current: [] });
  });
});

describe("splitCards", () => {
  it("keeps the newest card and drafts awaiting the user in view, folding the rest", () => {
    const cards = [card("digest2", "digest"), card("old", "digest"), card("draft", "draft", "pending"),
      card("sent", "draft", "sent"), card("sending", "draft", "sending")];
    const { primary, earlier } = splitCards(cards);
    expect(primary.map(c => c.id)).toEqual(["digest2", "draft", "sending"]);
    expect(earlier.map(c => c.id)).toEqual(["old", "sent"]);
  });
});
