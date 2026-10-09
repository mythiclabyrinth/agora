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
import { draftSync, useAddressed, useMessageDrafts } from "@agora/core";
import { KEY_RECENT } from "../src/state/servers";
import { useInboxTab } from "../src/state/inboxTab";
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
  draftSync.resetAll();
  useSession.setState({ draftIdentity: null, status: "signedOut", session: null });
  useInboxTab.setState({ tab: "unreads", filter: "all" });
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("signIn", () => {
  it("keeps a draft after load's me check fails but the app resolves the same identity", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async key =>
      key === KEY_URL ? "https://a.example" : key === KEY_TOKEN ? "old" : null);
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    await useSession.getState().load();
    expect(useSession.getState().draftIdentity).toBeNull();
    useSession.getState().rememberDraftIdentity("https://a.example", "tom");
    await useSession.getState().expireSession();
    draftSync.edit("general", "important offline text");
    (global.fetch as jest.Mock).mockImplementation(async input =>
      resp(String(input).endsWith("/api/me") ? me : {}, 200, String(input)));
    await useSession.getState().signIn("https://a.example", "new");
    expect(useMessageDrafts.getState().byConvo.general).toBe("important offline text");
  });

  it("keeps unsynced text through expiry and same-user sign-in", async () => {
    const identity = { server: "https://a.example", username: "tom" };
    useSession.setState({ status: "signedIn", session: { baseUrl: identity.server, token: "old" },
      username: "tom", draftIdentity: identity });
    useMessageDrafts.setState({ byConvo: { general: "unsynced" } });
    await useSession.getState().expireSession();
    expect(useMessageDrafts.getState().byConvo.general).toBe("unsynced");
    jest.spyOn(global, "fetch").mockImplementation(async input =>
      resp(String(input).endsWith("/api/me") ? me : {}, 200, String(input)));
    await useSession.getState().signIn(identity.server, "new");
    expect(useMessageDrafts.getState().byConvo.general).toBe("unsynced");
  });

  it("clears an expired session's drafts when a different user signs in", async () => {
    useSession.setState({ status: "signedOut", session: null,
      draftIdentity: { server: "https://a.example", username: "other" } });
    useMessageDrafts.setState({ byConvo: { general: "other account" } });
    jest.spyOn(global, "fetch").mockImplementation(async input =>
      resp(String(input).endsWith("/api/me") ? me : {}, 200, String(input)));
    await useSession.getState().signIn("https://a.example", "new");
    expect(useMessageDrafts.getState().byConvo).toEqual({});
  });
  it("resets the inbox tab and filter after a 401 before another user signs in", async () => {
    useSession.setState({ status: "signedIn", session: { baseUrl: "https://a.example", token: "old" },
      username: "other", draftIdentity: { server: "https://a.example", username: "other" } });
    useInboxTab.setState({ tab: "drafts", filter: "mentions" });
    await useSession.getState().expireSession();
    jest.spyOn(global, "fetch").mockImplementation(async input =>
      resp(String(input).endsWith("/api/me") ? me : {}, 200, String(input)));
    await useSession.getState().signIn("https://a.example", "new");
    expect(useInboxTab.getState()).toMatchObject({ tab: "unreads", filter: "all" });
  });
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
