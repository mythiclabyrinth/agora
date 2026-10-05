import { describe, expect, it } from "vitest";
import { initialChimeState, shouldChime } from "../src/lib/chime";
import type { Message } from "../src/api/types";

const message = (id: number, thread_id: number | null, author_id = "bot"): Message => ({
  id, channel_id: "general", thread_id, author_type: author_id === "me" ? "user" : "agent",
  author_id, author_name: author_id, text: "hello", ts: id,
} as Message);

describe("message chime coalescing", () => {
  it("plays once for a burst in one thread and reopens after five quiet seconds", () => {
    let state = initialChimeState();
    const plays: boolean[] = [];
    for (const [id, at] of [[1, 0], [2, 2_000], [3, 6_000], [4, 11_000]]) {
      const next = shouldChime(state, message(id, 42), "me", at);
      plays.push(next.play);
      state = next.state;
    }
    expect(plays).toEqual([true, false, false, true]);
  });

  it("keeps threads separate but applies a global one-second gap", () => {
    let state = initialChimeState();
    const first = shouldChime(state, message(1, 42), "me", 0);
    state = first.state;
    const tooSoon = shouldChime(state, message(2, 43), "me", 500);
    state = tooSoon.state;
    const afterGap = shouldChime(state, message(3, 43), "me", 1_100);
    expect([first.play, tooSoon.play, afterGap.play]).toEqual([true, false, true]);
  });

  it("ignores own messages and reconnect replays", () => {
    let state = initialChimeState();
    const own = shouldChime(state, message(1, null, "me"), "me", 0);
    expect(own.play).toBe(false);
    state = own.state;
    const first = shouldChime(state, message(2, null), "me", 1_000);
    expect(first.play).toBe(true);
    const replay = shouldChime(first.state, message(2, null), "me", 7_000);
    expect(replay.play).toBe(false);
  });
});
