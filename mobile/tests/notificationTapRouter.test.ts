/* Pin the notification hook-to-router wiring; the navigation policy itself
   stays covered separately in notificationRouting.test.ts. */

const mockPush = jest.fn();
const mockDismiss = jest.fn().mockResolvedValue(undefined);
let mockPathname = "/threads";
let mockResponse: ReturnType<typeof response> | null = null;
const mockRegistration = jest.fn();
const mockStoredSession = jest.fn();

jest.mock("../src/lib/notificationRegistration", () => ({
  readActionRegistration: () => mockRegistration(),
  currentStoredSession: () => mockStoredSession(),
}));

jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  router: { push: (...args: unknown[]) => mockPush(...args) },
  usePathname: () => mockPathname,
}));

jest.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "default",
  useLastNotificationResponse: () => mockResponse,
  dismissNotificationAsync: (...args: unknown[]) => mockDismiss(...args),
}));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NotificationTapRouter } from "../app/(app)/_layout";

function response(id: string, channelId: string, threadId?: number, context?: string) {
  return {
    actionIdentifier: "default",
    notification: {
      request: {
        identifier: id,
        content: {
          data: { channel_id: channelId, thread_id: threadId, ...(context ? { notification_context: context } : {}) },
        },
      },
    },
  };
}

function renderRouter() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(NotificationTapRouter));
  });
  return tree;
}

beforeEach(() => {
  mockPush.mockClear();
  mockDismiss.mockClear();
  mockPathname = "/threads";
  mockResponse = null;
  mockRegistration.mockResolvedValue({ context: "current", baseUrl: "https://current.example" });
  mockStoredSession.mockResolvedValue({ baseUrl: "https://current.example", token: "token" });
});

test("does not push when the notification target is already on top", () => {
  mockPathname = "/channel/c1";
  mockResponse = response("n1", "c1");
  renderRouter();
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockDismiss).toHaveBeenCalledWith("n1");
});

test("background action buttons do not navigate or dismiss a replacement card", () => {
  mockResponse = response("n1", "c1");
  mockResponse.actionIdentifier = "agora.action.0";
  renderRouter();
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
});

test("a body tap from a prior server/account cannot route into an unrelated message", async () => {
  mockResponse = response("n1", "c1", undefined, "old-context");
  await act(async () => { TestRenderer.create(React.createElement(NotificationTapRouter)); });
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
});

test("a matching-context body tap opens the conversation", async () => {
  mockResponse = response("n1", "c1", undefined, "current");
  await act(async () => { TestRenderer.create(React.createElement(NotificationTapRouter)); });
  expect(mockPush).toHaveBeenCalledWith("/channel/c1");
});

test("pushes exactly once for a different notification target", () => {
  mockResponse = response("n1", "c1", 42);
  renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith("/thread/c1/42");
});

test("does not push a repeated notification identifier after pathname changes", () => {
  mockResponse = response("n1", "c1");
  const tree = renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);

  mockPathname = "/channel/c1";
  act(() => tree.update(React.createElement(NotificationTapRouter)));
  expect(mockPush).toHaveBeenCalledTimes(1);
});
