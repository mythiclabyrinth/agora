/* signIn's origin canonicalization: the token must ride to the origin the
   server actually answers from, never across a redirect (which strips the
   Authorization header on iOS). */

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "after-first-unlock",
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  requestPermissionsAsync: jest.fn(async () => ({})),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[test]" })),
  scheduleNotificationAsync: jest.fn(),
  setBadgeCountAsync: jest.fn(async () => {}),
  dismissAllNotificationsAsync: jest.fn(async () => {}),
}));

jest.mock("expo-constants", () => ({
  expoConfig: { extra: { eas: { projectId: "test-project" } } },
}));

import * as SecureStore from "expo-secure-store";
import { useAddressed, useMessageDrafts } from "@agora/core";
import { KEY_RECENT } from "../src/state/servers";
import {
  KEY_INSTANCE_ADMIN,
  KEY_TOKEN,
  KEY_URL,
  useSession,
} from "../src/state/session";

function resp(body: unknown, status = 200, url = ""): Response {
  return {
    ok: status < 400,
    status,
    url,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const me = { username: "tom", voice: false };

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("signIn", () => {
  it("stores the canonical https origin learned from the probe", async () => {
    useMessageDrafts.setState({ byConvo: { general: "old account" } });
    useAddressed.setState({ byConvo: { general: ["old-agent"] } });
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return resp({ google: { enabled: true } }, 200, "https://a.example/api/auth/config");
      }
      expect(url).toBe("https://a.example/api/me");
      return resp(me, 200, url);
    });
    await useSession.getState().signIn("a.example", "tok");
    const state = useSession.getState();
    expect(state.status).toBe("signedIn");
    expect(state.session).toEqual({ baseUrl: "https://a.example", token: "tok" });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY_URL, "https://a.example",
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
    // A successful sign-in records the server in the recent list.
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      KEY_RECENT,
      JSON.stringify(["https://a.example"]),
    );
    expect(useMessageDrafts.getState().byConvo).toEqual({});
    expect(useAddressed.getState().byConvo).toEqual({});
  });

  it("surfaces a 401 as an error", async () => {
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) throw new Error("offline");
      return resp({ detail: "Authentication required" }, 401);
    });
    await expect(
      useSession.getState().signIn("http://192.168.1.10:8890", "bad"),
    ).rejects.toThrow("Authentication required");
  });
});

describe("cached instance role", () => {
  it.each([
    ["true", true, true],
    ["false", false, true],
    [null, false, false],
  ] as const)(
    "hydrates cached value %s as admin=%s known=%s",
    async (cached, admin, known) => {
      (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key) => {
        if (key === KEY_URL) return "https://a.example";
        if (key === KEY_TOKEN) return "tok";
        if (key === KEY_INSTANCE_ADMIN) return cached;
        return null;
      });
      jest.spyOn(global, "fetch").mockImplementation(
        () => new Promise<Response>(() => {}),
      );

      await useSession.getState().load();

      expect(useSession.getState().instanceAdmin).toBe(admin);
      expect(useSession.getState().instanceAdminKnown).toBe(known);
    },
  );

  it.each(["signOut", "forgetServer"] as const)(
    "%s clears the cached role",
    async (action) => {
      useSession.setState({ session: null });
      useMessageDrafts.setState({ byConvo: { general: "private draft" } });
      useAddressed.setState({ byConvo: { general: ["agent"] } });
      await useSession.getState()[action]();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
        KEY_INSTANCE_ADMIN,
      );
      for (const key of [KEY_TOKEN, "agora_admin_key", "agora_owner_token",
        "agora_notification_registration_v1", "agora_notification_registration_v2"]) {
        expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(key);
      }
      if (action === "forgetServer") {
        expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(KEY_URL);
        expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("agora_server_url");
      } else {
        expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith(KEY_URL);
      }
      expect(useMessageDrafts.getState().byConvo).toEqual({});
      expect(useAddressed.getState().byConvo).toEqual({});
    },
  );
});
