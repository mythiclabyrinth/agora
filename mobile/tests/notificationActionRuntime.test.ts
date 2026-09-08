let mockPlatform = "android";
const mockCategories = jest.fn(async (..._args: unknown[]) => {});
const mockRegister = jest.fn(async (..._args: unknown[]) => {});
const mockDefine = jest.fn();
const mockListen = jest.fn();
const mockSchedule = jest.fn();
const mockExecute = jest.fn();
const mockSessionRead = jest.fn();
const mockRegistrationRead = jest.fn();
let mockEpoch = 0;
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
  currentStoredSession: () => mockSessionRead(),
  readActionRegistration: () => mockRegistrationRead(),
  registrationEpoch: () => mockEpoch,
}));

import fixture from "../../packages/core/testing/notification-actions.json";
let runtime: typeof import("../src/lib/notificationActionRuntime");
beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  mockSessionRead.mockResolvedValue(mockSession);
  mockRegistrationRead.mockResolvedValue(mockRegistration);
});

function loadRuntime(platform: string) {
  mockPlatform = platform;
  runtime = require("../src/lib/notificationActionRuntime");
}

test("iOS registers warm-process actions without defining or registering Android tasks", async () => {
  loadRuntime("ios");
  runtime.installNotificationActionHandlers();
  expect(await runtime.setupNotificationActions()).toBe(true);
  expect(await runtime.setupNotificationActions()).toBe(true);
  expect(mockDefine).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();
  expect(mockListen).toHaveBeenCalledTimes(1);
  expect(mockCategories).toHaveBeenCalledTimes(42);
  for (const [, actions] of mockCategories.mock.calls) {
    expect((actions as { options: { opensAppToForeground: boolean } }[])
      .every((action) => !action.options.opensAppToForeground)).toBe(true);
  }
});

test("Android defines the headless task before registration and feedback preserves retry bindings", async () => {
  loadRuntime("android");
  runtime.installNotificationActionHandlers();
  expect(mockDefine).toHaveBeenCalledTimes(1);
  expect(await runtime.setupNotificationActions()).toBe(true);
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
    identifier: "msg:42", content: { categoryIdentifier: fixture[0].expected!.category,
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

const response = { actionIdentifier: "agora.action.0", notification: { request: {
  identifier: "msg:42", content: { body: "Bash command", data: { message_id: 42, pending_interaction: true,
    notification_actions: { ...fixture[0].expected, context: mockRegistration.context } } },
} } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test.each(["recorded", "retry", "open"])("iOS listener handles %s feedback", async (outcome) => {
  loadRuntime("ios");
  await runtime.setupNotificationActions();
  mockExecute.mockResolvedValueOnce(outcome);
  mockListen.mock.calls[0][0](response);
  await flush();
  expect(mockSchedule).toHaveBeenCalledTimes(1);
  const content = mockSchedule.mock.calls[0][0].content;
  expect(content.title).toBe(outcome === "recorded" ? "Response sent" : outcome === "retry"
    ? "Could not confirm — retry or open Agora" : "Open Agora to review this request");
  expect(content.data.pending_interaction).toBe(outcome !== "recorded");
});

test.each(["missing", "unreadable"])("iOS preserves an open-app reminder for %s credentials", async (state) => {
  loadRuntime("ios");
  await runtime.setupNotificationActions();
  mockExecute.mockRejectedValueOnce(new Error("Keychain unavailable"));
  if (state === "missing") {
    mockSessionRead.mockResolvedValue(null);
    mockRegistrationRead.mockResolvedValue(null);
  } else {
    mockSessionRead.mockRejectedValue(new Error("locked"));
    mockRegistrationRead.mockRejectedValue(new Error("locked"));
  }
  mockListen.mock.calls[0][0](response);
  await flush();
  expect(mockSchedule.mock.calls[0][0].content).toMatchObject({
    title: "Open Agora to review this request", data: { pending_interaction: true },
  });
  expect(mockSchedule.mock.calls[0][0].content.data.notification_actions).toBeUndefined();
});

test.each(["epoch", "context"])("iOS never recreates an old-account card after a %s change", async (change) => {
  loadRuntime("ios");
  await runtime.setupNotificationActions();
  mockExecute.mockImplementationOnce(async () => {
    if (change === "epoch") mockEpoch += 1;
    else mockRegistrationRead.mockResolvedValue({ ...mockRegistration, context: "b".repeat(32) });
    return "recorded";
  });
  mockListen.mock.calls[0][0](response);
  await flush();
  expect(mockSchedule).not.toHaveBeenCalled();
});
