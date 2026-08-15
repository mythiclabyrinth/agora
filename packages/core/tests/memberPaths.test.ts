import { describe, expect, it } from "vitest";
import { memberRemovalPath, resolveMemberGroupId } from "../src/api/memberPaths";

describe("membership mutation targets", () => {
  it("prefers the per-mutation group override", () => {
    expect(resolveMemberGroupId("bound", "override")).toBe("override");
    expect(resolveMemberGroupId("bound")).toBe("bound");
    expect(() => resolveMemberGroupId()).toThrow("A group is required");
  });

  it("keeps channel removal distinct from all-scope removal", () => {
    expect(memberRemovalPath({ groupId: "g", memberType: "user", memberId: "a b", channelId: "c/d" }))
      .toBe("/api/groups/g/members/user/a%20b?channel_id=c%2Fd");
    expect(memberRemovalPath({ groupId: "g", memberType: "user", memberId: "alice", allScopes: true }))
      .toBe("/api/groups/g/members/user/alice?all_scopes=true");
    expect(memberRemovalPath({ groupId: "g", memberType: "user", memberId: "alice" }))
      .toBe("/api/groups/g/members/user/alice");
    expect(() => memberRemovalPath({ groupId: "g", memberType: "user", memberId: "alice", channelId: "c", allScopes: true }))
      .toThrow("cannot target one channel and all scopes");
  });
});
