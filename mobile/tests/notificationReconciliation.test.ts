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

beforeEach(() => { mockDismiss.mockClear(); mockPresented.mockClear(); mockPresented.mockResolvedValue([card("pending")]); });
afterEach(() => { jest.restoreAllMocks(); });

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

test("resume fetches pending messages that are outside the loaded query pages", async () => {
  const fetch = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200,
    json: async () => message(true) } as Response);
  await reconcileNotifications([],[],session);
  expect(fetch).toHaveBeenCalledWith("https://agora.example/api/messages/42", expect.objectContaining({
    headers: { Authorization: "Bearer token" }, redirect: "error",
  }));
  expect(mockDismiss).toHaveBeenCalledWith("pending");
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
