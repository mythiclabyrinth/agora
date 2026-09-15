import { describe, expect, it } from "vitest";
import {
  fetchedMessagePageLength,
  rememberFetchedMessagePageLength,
} from "../src";

describe("message page server lengths", () => {
  it("keeps a short server page short after live messages fill its cached array", () => {
    const lengths = new Map<string, number>();
    rememberFetchedMessagePageLength(lengths, "general:root:initial", 49);

    expect(fetchedMessagePageLength(lengths, "general:root:initial", 50)).toBe(49);
  });

  it("falls back to cached length when bounded metadata is unavailable", () => {
    expect(fetchedMessagePageLength(new Map(), "general:root:initial", 50)).toBe(50);
  });

  it("refreshes entries and caps retained metadata", () => {
    const lengths = new Map<string, number>();
    rememberFetchedMessagePageLength(lengths, "keep", 49);
    for (let i = 0; i < 1000; i++) {
      rememberFetchedMessagePageLength(lengths, `page-${i}`, 50);
    }
    rememberFetchedMessagePageLength(lengths, "keep", 48);
    rememberFetchedMessagePageLength(lengths, "overflow", 1);

    expect(lengths.size).toBe(1000);
    expect(lengths.get("keep")).toBe(48);
    expect(lengths.has("page-0")).toBe(false);
  });
});
