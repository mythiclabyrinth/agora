let mockPlatform = "android";
const mockCategories = jest.fn(async (..._args: unknown[]) => {});
const mockRegister = jest.fn(async (..._args: unknown[]) => {});
const mockDefine = jest.fn();
const mockListen = jest.fn();
const mockSchedule = jest.fn();
const mockExecute = jest.fn();
const mockSession = { baseUrl: "https://agora.example", token: "token" };
const mockRegistration = { baseUrl: mockSession.baseUrl, context: "a".repeat(32), username: "ana" };

jest.mock("react-native", () => {
  const actual = jest.requireActual("react-native");
  Object.defineProperty(actual.Platform, "OS", { configurable: true, get: () => mockPlatform });
  return actual;
});
jest.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: (...args: unknown[]) => mockCategories(...args),
  registerTaskAsync: (...args: unknown[]) => mockRegister(...args),
  addNotificationResponseReceivedListener: (...args: unknown[]) => mockListen(...args),
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
}));
jest.mock("expo-task-manager", () => ({ defineTask: (...args: unknown[]) => mockDefine(...args) }));
jest.mock("../src/lib/notificationActionExecutor", () => ({
  executeNotificationAction: (...args: unknown[]) => mockExecute(...args),
}));
jest.mock("../src/lib/notificationRegistration", () => ({
  currentStoredSession: async () => mockSession,
  readActionRegistration: async () => mockRegistration,
}));

// Runtime imports helpers directly to avoid loading React through the barrel.
jest.mock("@agora/core", () => jest.requireActual("../../packages/core/src/notifications/actions"));

import fixture from "../../packages/core/testing/notification-actions.json";
import { installNotificationActionHandlers, setupNotificationActions } from "../src/lib/notificationActionRuntime";

test("iOS does not advertise action support before the native handler exists", async () => {
  mockPlatform = "ios";
  installNotificationActionHandlers();
  expect(await setupNotificationActions()).toBe(false);
  expect(mockRegister).not.toHaveBeenCalled();
  expect(mockListen).not.toHaveBeenCalled();
});

test("Android defines the headless task before registration and feedback preserves retry bindings", async () => {
  mockPlatform = "android";
  installNotificationActionHandlers();
  expect(mockDefine).toHaveBeenCalledTimes(1);
  expect(await setupNotificationActions()).toBe(true);
  expect(mockRegister).toHaveBeenCalledTimes(1);
  expect(mockCategories.mock.calls.length).toBeGreaterThan(0);
  const task = mockDefine.mock.calls[0][1];
  const response = { actionIdentifier: "agora.action.0", notification: { request: {
    identifier: "msg:42", content: { body: "Bash command", data: { message_id: 42, pending_interaction: true,
      notification_actions: { ...fixture[0].expected, context: mockRegistration.context } } },
  } } };
  mockExecute.mockResolvedValueOnce("retry");
  await task({ data: response });
  expect(mockSchedule.mock.calls[0][0]).toMatchObject({
    identifier: "msg:42", content: { categoryIdentifier: fixture[0].expected.category,
      data: { pending_interaction: true, notification_actions: { context: mockRegistration.context } } },
  });
  mockExecute.mockResolvedValueOnce("recorded");
  await task({ data: response });
  const resolved = mockSchedule.mock.calls[1][0];
  expect(resolved.content.title).toBe("Response sent");
  expect(resolved.content.categoryIdentifier).toBeUndefined();
  expect(resolved.content.data.notification_actions).toBeUndefined();
  expect(resolved.content.data.pending_interaction).toBe(false);
  mockExecute.mockResolvedValueOnce("open");
  await task({ data: response });
  const reminder = mockSchedule.mock.calls[2][0];
  expect(reminder.content.data.pending_interaction).toBe(true);
  expect(reminder.content.data.notification_actions).toBeUndefined();
  expect(reminder.content.categoryIdentifier).toBeUndefined();
});
