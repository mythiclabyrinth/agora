import { describe, expect, it } from "vitest";
import { fmtLastReply, fmtLastReplyFull, mentionPrefix, slugify } from "../src/lib/format";

describe("fmtLastReply", () => {
  const local = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute).getTime();

  it("uses a compact time today and a date for older replies", () => {
    const now = local(2026, 9, 28, 18, 0);
    expect(fmtLastReply(local(2026, 9, 28, 14, 15) / 1000, now)).toBe(
      new Date(local(2026, 9, 28, 14, 15)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    expect(fmtLastReply(local(2026, 9, 27, 14, 15) / 1000, now)).toBe(
      new Date(local(2026, 9, 27, 14, 15)).toLocaleString([], {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      }),
    );
    expect(fmtLastReply(local(2025, 9, 28, 14, 15) / 1000, now)).toBe(
      new Date(local(2025, 9, 28, 14, 15)).toLocaleDateString([], {
        month: "short", day: "numeric", year: "numeric",
      }),
    );
  });

  it("includes the year and time in the full accessible date", () => {
    const ts = local(2025, 9, 28, 14, 15) / 1000;
    expect(fmtLastReplyFull(ts)).toBe(new Date(ts * 1000).toLocaleString([], {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }));
    expect(fmtLastReplyFull(ts)).toContain("2025");
  });
});

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
