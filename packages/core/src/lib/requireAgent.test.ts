import { describe, expect, it } from "vitest";
import {
  disableRequireAgent,
  enableRequireAgent,
  parseRequireAgentKeys,
  REQUIRE_AGENT_MAX,
} from "./requireAgent";

describe("requireAgent LRU helpers", () => {
  it("enables by moving the key to the front", () => {
    expect(enableRequireAgent(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(enableRequireAgent(["a"], "c")).toEqual(["c", "a"]);
  });

  it("disables by dropping the key", () => {
    expect(disableRequireAgent(["a", "b"], "a")).toEqual(["b"]);
    expect(disableRequireAgent(["a"], "missing")).toEqual(["a"]);
  });

  it("caps the on-list at REQUIRE_AGENT_MAX", () => {
    const keys = Array.from({ length: REQUIRE_AGENT_MAX }, (_, i) => `k${i}`);
    const next = enableRequireAgent(keys, "fresh");
    expect(next).toHaveLength(REQUIRE_AGENT_MAX);
    expect(next[0]).toBe("fresh");
    expect(next).not.toContain(`k${REQUIRE_AGENT_MAX - 1}`);
  });

  it("parses persisted blobs defensively", () => {
    expect(parseRequireAgentKeys(null)).toEqual([]);
    expect(parseRequireAgentKeys(["a", 1, "", "b"])).toEqual(["a", "b"]);
  });
});
