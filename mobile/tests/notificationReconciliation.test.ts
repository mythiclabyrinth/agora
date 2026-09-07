const mockPresented = jest.fn();
const mockDismiss = jest.fn(async (..._args: unknown[]) => {});
let mockEpoch = 0;
const mockContext = "a".repeat(32);

jest.mock("expo-notifications", () => ({
  getPresentedNotificationsAsync: () => mockPresented(),
  dismissNotificationAsync: (...args: unknown[]) => mockDismiss(...args),
}));
jest.mock("../src/lib/notificationActionRuntime", () => ({ setupNotificationActions: async () => false }));
jest.mock("../src/lib/notificationRegistration", () => ({
  registrationEpoch: () => mockEpoch,
  readActionRegistration: async () => ({ context: mockContext }),
}));

import type { Message } from "@agora/core";
import fixture from "../../packages/core/testing/notification-actions.json";
import { dismissResolvedNotification, reconcileNotifications } from "../src/lib/notifications";

const session = { baseUrl: "https://agora.example", token: "token" };
const card = (identifier: string, context = mockContext) => ({ request: { identifier, content: { data: {
  channel_id: "c1", message_id: 42, pending_interaction: true,
  notification_actions: { ...fixture[0].expected, context },
} } } });
const message = (resolved: boolean): Message => ({ id: 42, meta: {
  ...fixture[0].meta, ...(resolved ? { resolved: { by: "another-member", option_id: "allow" } } : {}),
} } as Message);

beforeEach(() => { mockEpoch += 1; mockDismiss.mockClear(); mockPresented.mockClear(); mockPresented.mockResolvedValue([card("pending")]); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test("ordinary unresolved message edits skip notification enumeration", async () => {
  await dismissResolvedNotification(message(false));
  await dismissResolvedNotification({ ...message(false), meta: { table_rows: {} } } as Message);
  expect(mockPresented).not.toHaveBeenCalled();
});

test("WS completion dismisses the matching request, including another member's choice", async () => {
  mockPresented.mockResolvedValue([card("pending"), card("old-account", "b".repeat(32))]);
  await dismissResolvedNotification(message(true));
  expect(mockDismiss.mock.calls).toEqual([["pending"]]);
});

test.each([[42, true], ["42", "true"]])("resume fetches pending message %s with flag %s outside loaded query pages", async (message_id, pending_interaction) => {
  const pending = card("pending");
  mockPresented.mockResolvedValue([{ request: { ...pending.request, content: {
    data: { ...pending.request.content.data, message_id, pending_interaction },
  } } }]);
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200,
    json: async () => message(true) } as Response);
  await reconcileNotifications([],[],session);
  expect(fetch).toHaveBeenCalledWith("https://agora.example/api/messages/42", expect.objectContaining({
    headers: { Authorization: "Bearer token" }, redirect: "error",
  }));
  expect(mockDismiss).toHaveBeenCalledWith("pending");
});

test("an unchanged card set cools down briefly, then checks again", async () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000);
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200,
    json: async () => message(false) } as Response);
  await reconcileNotifications([], [], session);
  await reconcileNotifications([], [], session);
  expect(fetch).toHaveBeenCalledTimes(1);
  now.mockReturnValue(6001);
  await reconcileNotifications([], [], session);
  expect(fetch).toHaveBeenCalledTimes(2);
  mockPresented.mockResolvedValue([card("new-card")]);
  await reconcileNotifications([], [], session);
  expect(fetch).toHaveBeenCalledTimes(3);
  mockEpoch += 1;
  await reconcileNotifications([], [], session);
  expect(fetch).toHaveBeenCalledTimes(4);
});

test("all cards start concurrently and share one deadline; late results cannot dismiss", async () => {
  jest.useFakeTimers();
  mockPresented.mockResolvedValue([card("one"), card("two"), card("three")]);
  let finish!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => { finish = resolve; });
  const fetch = jest.spyOn(global, "fetch").mockReturnValue(waiting);
  const run = reconcileNotifications([], [], session);
  await jest.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
  await jest.advanceTimersByTimeAsync(8000);
  await run;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  finish({ ok: true, status: 200, json: async () => message(true) } as Response);
  await jest.advanceTimersByTimeAsync(0);
  expect(mockDismiss).not.toHaveBeenCalled();
});

test.each([403,404])("inaccessible/deleted requests (%s) are removed", async (status) => {
  jest.spyOn(global,"fetch").mockResolvedValue({ ok: false, status } as Response);
  await reconcileNotifications([],[],session);
  expect(mockDismiss).toHaveBeenCalledWith("pending");
});

test("an offline resume preserves pending cards", async () => {
  jest.spyOn(global,"fetch").mockRejectedValue(new Error("offline"));
  await reconcileNotifications([],[],session);
  expect(mockDismiss).not.toHaveBeenCalled();
});

test.each([false, "false"])("a nonpending flag %s does not trigger reconciliation fetches", async (pending_interaction) => {
  const existing = card("done");
  mockPresented.mockResolvedValue([{ request: { ...existing.request, content: {
    data: { ...existing.request.content.data, pending_interaction },
  } } }]);
  const fetch = jest.spyOn(global, "fetch");
  await reconcileNotifications([], [], session);
  expect(fetch).not.toHaveBeenCalled();
});

test("old-account cards are removed without fetching a same-id message on the new server", async () => {
  mockPresented.mockResolvedValue([card("old-account","b".repeat(32))]);
  const fetch = jest.spyOn(global,"fetch").mockRejectedValue(new Error("must not request"));
  await reconcileNotifications([],[],session);
  expect(fetch).not.toHaveBeenCalled();
  expect(mockDismiss).toHaveBeenCalledWith("old-account");
});

test("sign-out while fetching cannot dismiss a new session's same-id card", async () => {
  jest.spyOn(global,"fetch").mockImplementation(async () => {
    mockEpoch += 1;
    return { ok:true,status:200,json:async () => message(true) } as Response;
  });
  await reconcileNotifications([],[],session);
  expect(mockDismiss).not.toHaveBeenCalled();
});
