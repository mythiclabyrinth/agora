const mockItems = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "after-first-unlock",
  getItemAsync: jest.fn(async (key: string) => mockItems.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockItems.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockItems.delete(key); }),
}));

import { clearActionRegistration, currentStoredSession, KEY_TOKEN, KEY_URL,
  readActionRegistration, registrationEpoch, saveActionRegistration, readCredential,
  writeCredential, deleteCredential, prepareNotificationCredentials } from "../src/lib/notificationRegistration";
import * as SecureStore from "expo-secure-store";

const session = { baseUrl: "https://one.example", token: "session-one" };
const registration = { baseUrl: session.baseUrl, context: "a".repeat(32), username: "ana" };
beforeEach(() => { jest.clearAllMocks(); mockItems.clear(); mockItems.set(KEY_URL,session.baseUrl); mockItems.set(KEY_TOKEN,session.token); });

test("persists a binding only for the same current credentials", async () => {
  expect(await saveActionRegistration(registration,session,registrationEpoch())).toBe(true);
  expect(await readActionRegistration()).toEqual(registration);
  expect(await currentStoredSession()).toEqual(session);
});

test.each(["agora_admin_key", "agora_owner_token"])("migrates %s by writing the accessible successor before deleting legacy copies", async (oldKey) => {
  mockItems.delete(KEY_TOKEN);
  mockItems.set(oldKey, session.token);
  expect(await readCredential(KEY_TOKEN)).toBe(session.token);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY_TOKEN, session.token,
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  expect((SecureStore.setItemAsync as jest.Mock).mock.invocationCallOrder[0])
    .toBeLessThan((SecureStore.deleteItemAsync as jest.Mock).mock.invocationCallOrder[0]);
  expect(mockItems.get(KEY_TOKEN)).toBe(session.token);
  expect(mockItems.has(oldKey)).toBe(false);
});

test("preparation migrates URL and registration as well as the token", async () => {
  mockItems.clear();
  mockItems.set("agora_server_url", session.baseUrl);
  mockItems.set("agora_admin_key", session.token);
  mockItems.set("agora_notification_registration_v1", JSON.stringify(registration));
  expect(await prepareNotificationCredentials(session)).toBe(true);
  expect(await readActionRegistration()).toEqual(registration);
  expect((SecureStore.setItemAsync as jest.Mock).mock.calls.map(([key]) => key))
    .toEqual([KEY_URL, KEY_TOKEN, "agora_notification_registration_v2"]);
  for (const [, , options] of (SecureStore.setItemAsync as jest.Mock).mock.calls) {
    expect(options).toEqual({ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  }
});

test("existing v2 credentials win without rewriting them", async () => {
  mockItems.set("agora_admin_key", "obsolete");
  expect(await currentStoredSession()).toEqual(session);
  expect(await prepareNotificationCredentials(session)).toBe(true);
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

test("legacy cleanup failure does not reject a successfully stored credential", async () => {
  mockItems.set("agora_admin_key", "old-token");
  (SecureStore.deleteItemAsync as jest.Mock).mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(writeCredential(KEY_TOKEN, "new-token")).resolves.toBeUndefined();
  expect(await readCredential(KEY_TOKEN)).toBe("new-token");
  expect(mockItems.get("agora_admin_key")).toBe("old-token");
  await clearActionRegistration();
  await deleteCredential(KEY_TOKEN);
  expect(await readCredential(KEY_TOKEN)).toBeNull();
});

test("a failed migration keeps login readable but does not advertise readiness", async () => {
  mockItems.delete(KEY_TOKEN);
  mockItems.set("agora_admin_key", session.token);
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("write failed"));
  expect(await prepareNotificationCredentials(session)).toBe(false);
  expect(mockItems.get("agora_admin_key")).toBe(session.token);
  expect(mockItems.has(KEY_TOKEN)).toBe(false);
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("write failed"));
  expect(await currentStoredSession()).toEqual(session);
  expect(await prepareNotificationCredentials(session)).toBe(true);
});

test("a crash after writing v2 does not revive an old token on logout", async () => {
  mockItems.set("agora_admin_key", "old");
  mockItems.set("agora_owner_token", "older");
  await clearActionRegistration();
  await deleteCredential(KEY_TOKEN);
  expect(await currentStoredSession()).toBeNull();
  expect(mockItems.has("agora_admin_key")).toBe(false);
  expect(mockItems.has("agora_owner_token")).toBe(false);
});

test("concurrent migration and logout cannot resurrect credentials", async () => {
  mockItems.delete(KEY_TOKEN);
  mockItems.set("agora_admin_key", session.token);
  let release!: () => void;
  let writing!: () => void;
  const entered = new Promise<void>((resolve) => { writing = resolve; });
  (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(async (key, value) => {
    writing();
    await new Promise<void>((resolve) => { release = resolve; });
    mockItems.set(key, value);
  });
  const read = readCredential(KEY_TOKEN);
  await entered;
  const clearing = clearActionRegistration();
  const deleting = deleteCredential(KEY_TOKEN);
  release();
  expect(await read).toBeNull();
  await Promise.all([clearing, deleting]);
  expect(await currentStoredSession()).toBeNull();
  await writeCredential(KEY_TOKEN, "new-account");
  expect(mockItems.get(KEY_TOKEN)).toBe("new-account");
});

test("sign-out invalidates an in-flight registration result", async () => {
  const started = registrationEpoch();
  await clearActionRegistration();
  expect(await saveActionRegistration(registration,session,started)).toBe(false);
  expect(await readActionRegistration()).toBeNull();
});

test.each([KEY_URL, KEY_TOKEN])("changing %s invalidates a late result", async (key) => {
  mockItems.set(key,"another-session");
  expect(await saveActionRegistration(registration,session,registrationEpoch())).toBe(false);
  expect(await readActionRegistration()).toBeNull();
});
