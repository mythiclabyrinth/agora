import fixtures from "../../packages/core/testing/notification-actions.json";
import type { Message } from "@agora/core";
import { executeNotificationAction } from "../src/lib/notificationActionExecutor";

const context = "a".repeat(32);
const data = { message_id: 42, pending_interaction: true,
  notification_actions: { ...fixtures[0].expected, context } };
const credentials = {
  session: { baseUrl: "https://agora.example", token: "test-token" },
  registration: { baseUrl: "https://agora.example", context, username: "ana" },
};
const message = (by?: string, option_id = "allow"): Message => ({
  id: 42, meta: { ...fixtures[0].meta, ...(by ? { resolved: { by, option_id } } : {}) },
} as Message);
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

test("sends the bound button id through the authenticated dispatcher", async () => {
  const request = jest.fn().mockResolvedValueOnce(response({ outcome: "recorded" }));
  expect(await executeNotificationAction(data, "agora.action.1", async () => credentials, request)).toBe("recorded");
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = request.mock.calls[0];
  expect(url).toBe("https://agora.example/api/messages/42/notification_action");
  expect(JSON.parse(options.body)).toEqual({ version: 1, context,
    category: data.notification_actions.category, action: fixtures[0].expected.actions[1] });
  expect(options.headers.Authorization).toBe("Bearer test-token");
  expect(options.redirect).toBe("error");
});

test.each(["ana", "someone-else"])("does not re-submit a choice already recorded by %s", async (by) => {
  const request = jest.fn().mockResolvedValue(by === "ana"
    ? response({ outcome: "already_recorded" }) : response({ detail: "Already handled", message: message(by) }, 409));
  expect(await executeNotificationAction(data,"agora.action.0",async () => credentials,request))
    .toBe(by === "ana" ? "recorded" : "handled");
  expect(request).toHaveBeenCalledTimes(1);
});

test("reconciles a lost POST response instead of falsely offering another submission", async () => {
  const request = jest.fn().mockRejectedValueOnce(new Error("connection lost after commit"))
    .mockResolvedValueOnce(response(message("ana")));
  expect(await executeNotificationAction(data,"agora.action.0",async () => credentials,request)).toBe("recorded");
  expect(request.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

test("a concurrent identical submission is success, a different choice is already handled", async () => {
  for (const choice of ["allow", "deny"]) {
    const request = jest.fn().mockResolvedValueOnce(response({ message: message("ana", choice) },409));
    expect(await executeNotificationAction(data,"agora.action.0",async () => credentials,request))
      .toBe(choice === "allow" ? "recorded" : "handled");
    expect(request).toHaveBeenCalledTimes(1);
  }
});

test("offline leaves a retry; expired credentials require opening the app", async () => {
  expect(await executeNotificationAction(data,"agora.action.0",async () => credentials,
    jest.fn().mockRejectedValue(new Error("offline")))).toBe("retry");
  expect(await executeNotificationAction(data,"agora.action.0",async () => credentials,
    jest.fn().mockResolvedValue(response({},401)))).toBe("open");
});

test("rejects old-server and old-account contexts before any network request", async () => {
  const request = jest.fn();
  const other = { ...credentials, registration: { ...credentials.registration, context: "b".repeat(32) } };
  expect(await executeNotificationAction(data,"agora.action.0",async () => other,request)).toBe("open");
  expect(request).not.toHaveBeenCalled();
});

test("account switching during credential reads prevents POST", async () => {
  const read = jest.fn().mockResolvedValueOnce(credentials).mockResolvedValueOnce(null);
  const request = jest.fn().mockResolvedValue(response(message()));
  expect(await executeNotificationAction(data,"agora.action.0",read,request)).toBe("open");
  expect(request).not.toHaveBeenCalled();
});

test("a conflict without an embedded message falls back to inspection", async () => {
  const request = jest.fn().mockResolvedValueOnce(response({}, 409))
    .mockResolvedValueOnce(response(message("ana")));
  expect(await executeNotificationAction(data, "agora.action.0", async () => credentials, request)).toBe("recorded");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1].method).toBe("POST");
  expect(request.mock.calls[1][1].method).toBeUndefined();
});

test("non-JSON authentication errors retain their status without another request", async () => {
  const request = jest.fn().mockResolvedValue({ ok: false, status: 401,
    json: async () => { throw new Error("not JSON"); } });
  expect(await executeNotificationAction(data, "agora.action.0", async () => credentials, request)).toBe("open");
  expect(request).toHaveBeenCalledTimes(1);
});

test("malformed and unknown-version pushes do not execute", async () => {
  const request = jest.fn();
  expect(await executeNotificationAction({ ...data, notification_actions: { ...data.notification_actions, version: 2 } },
    "agora.action.0",async () => credentials,request)).toBe("ignored");
  expect(await executeNotificationAction(data,"agora.action.9",async () => credentials,request)).toBe("ignored");
  expect(request).not.toHaveBeenCalled();
});
