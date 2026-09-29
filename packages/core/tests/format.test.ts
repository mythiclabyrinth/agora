import { describe, expect, it } from "vitest";
import { fmtLastReply, fmtLastReplyFull, fmtRelative, mentionPrefix, slugify, validLastReplyTs } from "../src/lib/format";

describe("fmtRelative", () => {
  it("uses compact units with clear boundaries and a localized date for older activity", () => {
    const now = new Date(2026, 8, 28, 18, 0).getTime();
    const at = (secondsAgo: number) => (now - secondsAgo * 1000) / 1000;
    expect(fmtRelative(at(59), now)).toBe("Just now");
    expect(fmtRelative(at(60), now)).toBe("1m");
    expect(fmtRelative(at(3599), now)).toBe("59m");
    expect(fmtRelative(at(3600), now)).toBe("1h");
    expect(fmtRelative(at(86399), now)).toBe("23h");
    expect(fmtRelative(at(86400), now)).toBe("1d");
    expect(fmtRelative(at(604799), now)).toBe("6d");
    const oldTs = at(604800);
    expect(fmtRelative(oldTs, now)).toBe(new Date(oldTs * 1000).toLocaleDateString([], {
      month: "short", day: "numeric",
    }));
    expect(fmtRelative(at(-1), now)).toBe("Just now");
  });
});

describe("validLastReplyTs", () => {
  it("accepts nonzero finite values within the JavaScript Date range", () => {
    expect(validLastReplyTs(1)).toBe(true);
    expect(validLastReplyTs(8.64e12)).toBe(true);
    expect(validLastReplyTs(0)).toBe(false);
    expect(validLastReplyTs(-1)).toBe(false);
    expect(validLastReplyTs(undefined)).toBe(false);
    expect(validLastReplyTs(Number.NaN)).toBe(false);
    expect(validLastReplyTs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(validLastReplyTs(8.64e12 + 1)).toBe(false);
  });
});

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

  it("omits the time for earlier days in compact mode", () => {
    const now = local(2026, 9, 28, 18, 0);
    const yesterday = local(2026, 9, 27, 14, 15) / 1000;
    const lastYear = local(2025, 9, 28, 14, 15) / 1000;
    expect(fmtLastReply(yesterday, now, { compact: true })).toBe(
      new Date(yesterday * 1000).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
    expect(fmtLastReply(lastYear, now, { compact: true })).toBe(
      new Date(lastYear * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }),
    );
    expect(fmtLastReply(local(2026, 9, 28, 14, 15) / 1000, now, { compact: true })).toBe(
      new Date(local(2026, 9, 28, 14, 15)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
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
