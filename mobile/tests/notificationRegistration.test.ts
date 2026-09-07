const mockItems = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockItems.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockItems.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockItems.delete(key); }),
}));

import { clearActionRegistration, currentStoredSession, KEY_TOKEN, KEY_URL,
  readActionRegistration, registrationEpoch, saveActionRegistration } from "../src/lib/notificationRegistration";

const session = { baseUrl: "https://one.example", token: "session-one" };
const registration = { baseUrl: session.baseUrl, context: "a".repeat(32), username: "ana" };
beforeEach(() => { mockItems.clear(); mockItems.set(KEY_URL,session.baseUrl); mockItems.set(KEY_TOKEN,session.token); });

test("persists a binding only for the same current credentials", async () => {
  expect(await saveActionRegistration(registration,session,registrationEpoch())).toBe(true);
  expect(await readActionRegistration()).toEqual(registration);
  expect(await currentStoredSession()).toEqual(session);
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
