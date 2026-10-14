import {
  LAND_NONCE_PARAM,
  notificationHref,
  notificationLandParams,
  notificationNavigationAction,
} from "../src/lib/notificationRouting";

describe("notificationNavigationAction", () => {
  it("does nothing when already viewing the target channel", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      target: "/channel/c1",
    })).toBe("none");
  });

  it("does nothing when already viewing the target thread", () => {
    expect(notificationNavigationAction({
      pathname: "/thread/c1/42",
      target: "/thread/c1/42",
    })).toBe("none");
  });

  it("pushes a notification for a different target to preserve the current draft", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      target: "/thread/c1/42",
    })).toBe("push");
  });

  it("pushes the first notification over a non-detail screen", () => {
    expect(notificationNavigationAction({
      pathname: "/threads",
      target: "/thread/c1/42",
    })).toBe("push");
  });

  it("lands in place when already viewing the conversation the message belongs to", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      target: "/channel/c1",
      messageId: 91,
    })).toBe("land");
    expect(notificationNavigationAction({
      pathname: "/thread/c1/42",
      target: "/thread/c1/42",
      messageId: 91,
    })).toBe("land");
  });
});

describe("notificationHref", () => {
  it("lands a channel notification on its message", () => {
    expect(notificationHref("/channel/c1", 91)).toBe("/channel/c1?messageId=91");
  });

  it("lands a thread notification on its reply", () => {
    expect(notificationHref("/thread/c1/42", 93)).toBe("/thread/c1/42?messageId=93");
  });

  it("opens the conversation itself for aggregate notifications", () => {
    expect(notificationHref("/channel/c1", null)).toBe("/channel/c1");
  });
});

describe("notificationLandParams", () => {
  it("carries a per-tap token so the same message can be landed on again", () => {
    expect(notificationLandParams(91, "n1@1")).toEqual({ messageId: "91", [LAND_NONCE_PARAM]: "n1@1" });
    expect(notificationLandParams(91, "n1@2")).not.toEqual(notificationLandParams(91, "n1@1"));
  });
});
