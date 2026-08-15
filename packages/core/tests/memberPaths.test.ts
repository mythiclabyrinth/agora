import { describe, expect, it } from "vitest";
import { memberRemovalPath, resolveMemberGroupId } from "../src/api/memberPaths";

describe("membership mutation targets", () => {
  it("prefers the per-mutation group override", () => {
    expect(resolveMemberGroupId("bound", "override")).toBe("override");
    expect(resolveMemberGroupId("bound")).toBe("bound");
  });

  it("keeps channel removal distinct from all-scope removal", () => {
    expect(memberRemovalPath({ groupId: "g", memberType: "user", memberId: "a b", channelId: "c/d", allScopes: true }))
      .toBe("/api/groups/g/members/user/a%20b?channel_id=c%2Fd");
    expect(memberRemovalPath({ groupId: "g", memberType: "user", memberId: "alice", allScopes: true }))
      .toBe("/api/groups/g/members/user/alice?all_scopes=true");
  });
});
