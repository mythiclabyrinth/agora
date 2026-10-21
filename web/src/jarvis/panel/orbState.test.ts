import { describe, expect, it } from "vitest";
import { orbLook, phaseLabel } from "./orbState";
import type { JarvisPhase } from "../../state/jarvis";

describe("orbLook", () => {
  it.each<[JarvisPhase, string, boolean]>([
    ["idle", "breathing", false],
    ["armed", "breathing", false],
    ["listening", "listening", false],
    ["recording", "listening", false],
    ["transcribing", "solving", false],
    ["thinking", "solving", false],
    ["searching", "searching", false],
    ["weaving", "weaving", false],
    ["composing", "composing", false],
    ["waiting", "connecting", false],
    ["speaking", "shaping", false],
    ["error", "breathing", true],
  ])("%s -> %s (paused=%s)", (phase, state, paused) => {
    expect(orbLook(phase)).toEqual({ state, paused });
  });

  it("falls back to idle for unknown phases from newer servers", () => {
    expect(orbLook("rehearsing" as JarvisPhase)).toEqual({ state: "breathing", paused: false });
  });

  it("has a label for every phase", () => {
    for (const p of ["idle", "armed", "listening", "recording", "transcribing", "thinking", "searching", "weaving", "composing", "waiting", "speaking", "error"] as JarvisPhase[]) {
      expect(phaseLabel(p).length).toBeGreaterThan(3);
    }
  });
});
