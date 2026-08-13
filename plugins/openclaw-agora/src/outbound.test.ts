import { describe, expect, it } from "vitest";
import { resolveTarget } from "./outbound.ts";

describe("resolveTarget", () => {
  it("accepts the shapes core hands back", () => {
    expect(resolveTarget("c1")).toEqual({ channelId: "c1", threadId: null });
    expect(resolveTarget("channel:c1")).toEqual({ channelId: "c1", threadId: null });
    expect(resolveTarget("agora:channel:c1")).toEqual({ channelId: "c1", threadId: null });
  });

  it("keeps the thread from a conversation id", () => {
    expect(resolveTarget("c1:42")).toEqual({ channelId: "c1", threadId: 42 });
  });

  it("prefers an explicit thread id from the reply plan", () => {
    expect(resolveTarget("c1", 7)).toEqual({ channelId: "c1", threadId: 7 });
    expect(resolveTarget("c1:42", "7")).toEqual({ channelId: "c1", threadId: 7 });
  });

  it("falls back to the channel root when the thread id is unusable", () => {
    expect(resolveTarget("c1", "not-a-number")).toEqual({ channelId: "c1", threadId: null });
  });
});
