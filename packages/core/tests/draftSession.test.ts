import { describe, expect, it } from "vitest";
import { draftIdentityChanged } from "../src/state/draftSession";

describe("web draft session boundaries", () => {
  it("preserves drafts when the same user signs in again on the same server", () => {
    const previous = { server: "https://agora.example", username: "ana" };
    expect(draftIdentityChanged(previous, { ...previous })).toBe(false);
    expect(draftIdentityChanged(previous, { ...previous, username: "bob" })).toBe(true);
    expect(draftIdentityChanged(previous, { ...previous, server: "https://elsewhere.example" })).toBe(true);
  });
});
