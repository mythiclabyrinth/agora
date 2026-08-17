import { describe, expect, it } from "vitest";
import { mentionPrefix, slugify } from "../src/lib/format";

describe("mentionPrefix", () => {
  it("returns empty string when no agents are addressed", () => {
    expect(mentionPrefix([])).toBe("");
  });

  it("formats a single agent", () => {
    expect(mentionPrefix([{ name: "Codex" }])).toBe("@codex");
  });

  it("joins multiple agents with commas", () => {
    expect(mentionPrefix([{ name: "Codex" }, { name: "Claude" }])).toBe(
      "@codex, @claude",
    );
  });

  it("slugifies punctuated names the same way typed mentions do", () => {
    expect(mentionPrefix([{ name: "Kite Bot" }, { name: "OpenAI-Codex" }])).toBe(
      `@${slugify("Kite Bot")}, @${slugify("OpenAI-Codex")}`,
    );
    expect(mentionPrefix([{ name: "Kite Bot" }])).toBe("@kite-bot");
  });
});
