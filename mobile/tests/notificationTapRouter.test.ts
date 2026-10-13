/* Pin the notification hook-to-router wiring; the navigation policy itself
   stays covered separately in notificationRouting.test.ts. */

const mockPush = jest.fn();
const mockSetParams = jest.fn();
const mockListeners = new Set<(r: unknown) => void>();
const mockClearedListeners = new Set<() => void>();
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
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    setParams: (...args: unknown[]) => mockSetParams(...args),
  },
  usePathname: () => mockPathname,
}));

jest.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "default",
  getLastNotificationResponse: () => mockResponse,
  addNotificationResponseReceivedListener: (listener: (r: unknown) => void) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  },
  addNotificationResponseClearedListener: (listener: () => void) => {
    mockClearedListeners.add(listener);
    return { remove: () => mockClearedListeners.delete(listener) };
  },
  dismissNotificationAsync: (...args: unknown[]) => mockDismiss(...args),
}));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NotificationTapRouter, resetHandledNotificationTap } from "../app/(app)/_layout";

function response(id: string, channelId: string, threadId?: number, context?: string, messageId?: number, date = 1) {
  return {
    actionIdentifier: "default",
    notification: {
      date,
      request: {
        identifier: id,
        content: {
          data: {
            channel_id: channelId,
            thread_id: threadId,
            ...(context ? { notification_context: context } : {}),
            ...(messageId ? { message_id: messageId } : {}),
          },
        },
      },
    },
  };
}

/** A tap arriving while the app is running. */
function emit(r: ReturnType<typeof response>) {
  for (const listener of mockListeners) listener(r);
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
  mockSetParams.mockClear();
  mockListeners.clear();
  mockClearedListeners.clear();
  resetHandledNotificationTap();
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

test.each(["missing", "unreadable"])("a %s registration falls back to body-tap navigation exactly once", async (state) => {
  if (state === "missing") mockRegistration.mockResolvedValue(null);
  else mockRegistration.mockRejectedValue(new Error("SecureStore unavailable"));
  mockResponse = response("n1", "c1", undefined, "current");
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(React.createElement(NotificationTapRouter)); });
  expect(mockPush).toHaveBeenCalledWith("/channel/c1");
  expect(mockDismiss).toHaveBeenCalledWith("n1");
  mockPathname = "/channel/c1";
  await act(async () => { tree.update(React.createElement(NotificationTapRouter)); });
  expect(mockPush).toHaveBeenCalledTimes(1);
});

test("a rejected foreign-context tap does not consume the notification identifier", async () => {
  mockResponse = response("n1", "c1", undefined, "current");
  mockRegistration.mockResolvedValue({ context: "foreign", baseUrl: "https://foreign.example" });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(React.createElement(NotificationTapRouter)); });
  expect(mockPush).not.toHaveBeenCalled();
  mockRegistration.mockResolvedValue(null);
  await act(async () => { emit(response("n1", "c1", undefined, "current")); });
  expect(mockPush).toHaveBeenCalledWith("/channel/c1");
});

test("an unmounted router ignores a late registration result", async () => {
  let finish!: (value: null) => void;
  mockRegistration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  mockResponse = response("n1", "c1", undefined, "current");
  const tree = renderRouter();
  act(() => tree.unmount());
  await act(async () => { finish(null); });
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
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

test("a channel notification lands on its message", () => {
  mockResponse = response("n1", "c1", undefined, undefined, 91);
  renderRouter();
  expect(mockPush).toHaveBeenCalledWith("/channel/c1?messageId=91");
});

test("a thread notification lands on its reply", () => {
  mockResponse = response("n1", "c1", 42, undefined, 93);
  renderRouter();
  expect(mockPush).toHaveBeenCalledWith("/thread/c1/42?messageId=93");
});

test.each([
  ["/channel/c1", undefined],
  ["/thread/c1/42", 42],
])("a tap while already in %s re-targets that screen instead of stacking it", (pathname, threadId) => {
  mockPathname = pathname;
  mockResponse = response("n1", "c1", threadId, undefined, 95);
  renderRouter();
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockSetParams).toHaveBeenCalledWith({ messageId: "95", landAt: "n1@1" });
  expect(mockDismiss).toHaveBeenCalledWith("n1");
});

test("a later card reusing the conversation's identifier still navigates", () => {
  mockPathname = "/channel/c1";
  mockResponse = response("channel:c1", "c1", undefined, undefined, 95, 1);
  renderRouter();
  expect(mockSetParams).toHaveBeenLastCalledWith({ messageId: "95", landAt: "channel:c1@1" });
  act(() => emit(response("channel:c1", "c1", undefined, undefined, 97, 2)));
  expect(mockSetParams).toHaveBeenLastCalledWith({ messageId: "97", landAt: "channel:c1@2" });
  expect(mockSetParams).toHaveBeenCalledTimes(2);
});

test("a second tap for the same message re-lands it with a fresh token", () => {
  mockPathname = "/channel/c1";
  mockResponse = response("channel:c1", "c1", undefined, undefined, 95, 1);
  renderRouter();
  act(() => emit(response("channel:c1", "c1", undefined, undefined, 95, 2)));
  expect(mockSetParams).toHaveBeenCalledTimes(2);
  const [first, second] = mockSetParams.mock.calls.map(([params]) => params);
  expect(first.messageId).toBe("95");
  expect(second.messageId).toBe("95");
  expect(second.landAt).not.toBe(first.landAt);
});

test("signing out and back in does not replay the tap already routed", () => {
  mockResponse = response("n1", "c1", undefined, undefined, 91);
  const first = renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);
  // Sign-out unmounts the router; signing back in mounts a fresh one, which
  // reads the same last response again.
  act(() => first.unmount());
  mockPathname = "/";
  const second = renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);
  // A new tap after that still routes.
  act(() => emit(response("n2", "c2", undefined, undefined, 5, 2)));
  expect(mockPush).toHaveBeenLastCalledWith("/channel/c2?messageId=5");
  act(() => second.unmount());
});

test("a cleared response is not acted on", async () => {
  mockPathname = "/channel/c1";
  mockResponse = response("n1", "c1", undefined, "current", 91);
  let finish!: (value: null) => void;
  mockRegistration.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const tree = renderRouter();
  // Cleared while the context check is still pending.
  act(() => { for (const listener of mockClearedListeners) listener(); });
  await act(async () => { finish(null); });
  expect(mockSetParams).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
