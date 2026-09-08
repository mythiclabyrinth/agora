const mockPrepare = jest.fn();
const mockSetupActions = jest.fn();
const mockSave = jest.fn();
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  requestPermissionsAsync: jest.fn(async () => ({})),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[test]" })),
}));
jest.mock("expo-secure-store", () => ({ setItemAsync: jest.fn(async () => {}) }));
jest.mock("expo-constants", () => ({
  expoConfig: { extra: { eas: { projectId: "test-project" } } },
}));
jest.mock("../src/lib/notificationActionRuntime", () => ({
  setupNotificationActions: () => mockSetupActions(),
}));
jest.mock("../src/lib/notificationRegistration", () => ({
  registrationEpoch: () => 0,
  prepareNotificationCredentials: (...args: unknown[]) => mockPrepare(...args),
  readActionRegistration: async () => null,
  saveActionRegistration: (...args: unknown[]) => mockSave(...args),
}));

import { ApiClient } from "@agora/core";
import { registerPushToken } from "../src/lib/notifications";

const session = { baseUrl: "https://agora.example", token: "test-token" };
beforeEach(() => {
  jest.clearAllMocks();
  mockPrepare.mockResolvedValue(true);
  mockSetupActions.mockResolvedValue(true);
  mockSave.mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

test.each([true, false])("action capability is advertised only after verified migration (%s)", async (ready) => {
  mockPrepare.mockResolvedValue(ready);
  const post = jest.spyOn(ApiClient.prototype, "post").mockResolvedValue({ notification_action_context: "a".repeat(32) });
  jest.spyOn(ApiClient.prototype, "get").mockResolvedValue({ username: "ana" });
  expect(await registerPushToken(session)).toBe(true);
  const body = post.mock.calls[0][1] as Record<string, unknown>;
  expect(body.notification_action_version).toBe(ready ? 1 : undefined);
  expect(mockSetupActions).toHaveBeenCalledTimes(ready ? 1 : 0);
  expect(mockSave).toHaveBeenCalledTimes(ready ? 1 : 0);
});

test("failed registration persistence is not reported as successful", async () => {
  jest.spyOn(ApiClient.prototype, "post").mockResolvedValue({ notification_action_context: "a".repeat(32) });
  jest.spyOn(ApiClient.prototype, "get").mockResolvedValue({ username: "ana" });
  mockSave.mockResolvedValue(false);
  expect(await registerPushToken(session)).toBe(false);
});
