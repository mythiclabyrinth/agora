import { describe, expect, it } from "vitest";
import { deepLinkPath, parseDeepLink, type DeepLinkTarget } from "../src";

describe("deep links", () => {
  const targets: DeepLinkTarget[] = [
    { kind: "group", groupId: "team one" },
    { kind: "channel", groupId: "team one", channelId: "general/chat" },
    {
      kind: "message",
      groupId: "team",
      channelId: "general",
      threadId: null,
      messageId: 481,
    },
    { kind: "thread", groupId: "team", channelId: "general", threadId: 450 },
    { kind: "thread", groupId: "__dms", channelId: "claude-m5-5b85", threadId: 10897 },
    {
      kind: "message",
      groupId: "team",
      channelId: "general",
      threadId: 450,
      messageId: 481,
    },
  ];

  it.each(targets)("round trips $kind targets", (target) => {
    expect(parseDeepLink(deepLinkPath(target))).toEqual(target);
  });

  it("accepts absolute instance URLs", () => {
    expect(parseDeepLink("https://chat.example/g/team/c/general/t/450?ignored=1")).toEqual({
      kind: "thread",
      groupId: "team",
      channelId: "general",
      threadId: 450,
    });
  });

  it("preserves encoded slashes inside ids", () => {
    expect(parseDeepLink("/g/team%2Fwest/c/general%2Fchat")).toEqual({
      kind: "channel",
      groupId: "team/west",
      channelId: "general/chat",
    });
  });

  it.each([
    "/",
    "/g",
    "/g//c/general",
    "/g/team/c",
    "/g/team/c//m/1",
    "/g/team/c/general/m/0",
    `/g/team/c/general/m/${Number.MAX_SAFE_INTEGER + 1}`,
    "/g/team/c/general/t/nope",
    "/g/team/c/general/t/1/extra",
  ])("rejects malformed path %s", (path) => {
    expect(parseDeepLink(path)).toBeNull();
  });
});
