import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { draftAuthRejected, draftIdentityChanged } from "../src/state/draftSession";

describe("web draft session boundaries", () => {
  it("keeps drafts after a transient me error", () => {
    expect(draftAuthRejected(new TypeError("offline"))).toBe(false);
    expect(draftAuthRejected(new ApiError(503, "unavailable"))).toBe(false);
  });

  it("clears drafts after an authentication rejection", () => {
    expect(draftAuthRejected(new ApiError(401, "expired"))).toBe(true);
    expect(draftAuthRejected(new ApiError(403, "revoked"))).toBe(true);
  });

  it("preserves drafts when the same user signs in again on the same server", () => {
    const previous = { server: "https://agora.example", username: "ana" };
    expect(draftIdentityChanged(previous, { ...previous })).toBe(false);
    expect(draftIdentityChanged(previous, { ...previous, username: "bob" })).toBe(true);
    expect(draftIdentityChanged(previous, { ...previous, server: "https://elsewhere.example" })).toBe(true);
  });
});
