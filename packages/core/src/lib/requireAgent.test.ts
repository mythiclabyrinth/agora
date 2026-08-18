import { describe, expect, it } from "vitest";
import {
  forgetRequireAgentOff,
  isRequireAgentOn,
  parseRequireAgentKeys,
  REQUIRE_AGENT_DEFAULT,
  REQUIRE_AGENT_MAX,
  rememberRequireAgentOff,
} from "./requireAgent";

describe("requireAgent LRU helpers", () => {
  it("defaults to on for a conversation with no stored exception", () => {
    expect(REQUIRE_AGENT_DEFAULT).toBe(true);
    expect(isRequireAgentOn([], "general:t42")).toBe(true);
    expect(isRequireAgentOn(["other:t1"], "general:t42")).toBe(true);
  });

  it("reports off only for keys on the exception list", () => {
    expect(isRequireAgentOn(["general:t42"], "general:t42")).toBe(false);
  });

  it("switches off by moving the key to the front", () => {
    expect(rememberRequireAgentOff(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberRequireAgentOff(["a"], "c")).toEqual(["c", "a"]);
  });

  it("switches back on by dropping the key", () => {
    expect(forgetRequireAgentOff(["a", "b"], "a")).toEqual(["b"]);
    expect(forgetRequireAgentOff(["a"], "missing")).toEqual(["a"]);
    expect(isRequireAgentOn(forgetRequireAgentOff(["a"], "a"), "a")).toBe(true);
  });

  it("caps the off-list at REQUIRE_AGENT_MAX", () => {
    const keys = Array.from({ length: REQUIRE_AGENT_MAX }, (_, i) => `k${i}`);
    const next = rememberRequireAgentOff(keys, "fresh");
    expect(next).toHaveLength(REQUIRE_AGENT_MAX);
    expect(next[0]).toBe("fresh");
    expect(next).not.toContain(`k${REQUIRE_AGENT_MAX - 1}`);
  });

  it("parses persisted blobs defensively", () => {
    expect(parseRequireAgentKeys(null)).toEqual([]);
    expect(parseRequireAgentKeys(["a", 1, "", "b"])).toEqual(["a", "b"]);
  });
});
