import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSync } from "../src/state/draftSync";
import { useMessageDrafts, type DraftRow } from "../src/state/drafts";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/client";
import { useAddressed } from "../src/state/addressed";
import { QueryClient } from "@tanstack/react-query";
import { applyWsEvent } from "../src/ws/reducer";

const row = (body: string, rev: number): DraftRow => ({ channel_id: "general", thread_id: null, body,
  meta: { addressed: [], reply_in_thread: false }, rev, client_id: "remote", updated_at: 1,
  channel_name: "general", group_id: "team", group_name: "Team", thread_title: null });

beforeEach(() => { draftSync.resetAll(); useAddressed.getState().resetAll(); vi.useFakeTimers(); });
afterEach(() => { draftSync.resetAll(); useAddressed.getState().resetAll(); vi.useRealTimers(); });

describe("draft sync", () => {
  it("debounces edits and sends metadata with the text", async () => {
    const put = vi.fn(async () => ({ ...row("hello", 1), client_id: draftSync.clientId }));
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "hello", { addressed: ["bot"], reply_in_thread: true });
    await vi.advanceTimersByTimeAsync(799);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "hello", meta: { addressed: ["bot"], reply_in_thread: true } }));
  });

  it("flushes continuous typing by five seconds", async () => {
    const put = vi.fn(async () => ({ ...row("typing", 1), client_id: draftSync.clientId }));
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    for (let i = 0; i < 10; i++) {
      draftSync.edit("general", `typing ${i}`);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("stops retries for invalid drafts and keeps the local text", async () => {
    const put = vi.fn(async () => { throw new ApiError(400, "Draft too long"); });
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "keep me");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(useMessageDrafts.getState().byConvo.general).toBe("keep me");
  });

  it("resumes syncing when the user corrects a rejected draft", async () => {
    const put = vi.fn().mockRejectedValueOnce(new ApiError(400, "Draft too long"))
      .mockResolvedValueOnce({ ...row("shorter", 1), client_id: draftSync.clientId });
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "too long");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(1);
    draftSync.edit("general", "shorter");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("resumes syncing when a rejected draft's settings change", async () => {
    const put = vi.fn().mockRejectedValueOnce(new ApiError(400, "Invalid draft settings"))
      .mockResolvedValueOnce({ ...row("ask", 1), meta: { addressed: ["bot"], reply_in_thread: false }, client_id: draftSync.clientId });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "ask");
    await vi.advanceTimersByTimeAsync(800);
    draftSync.editMeta("general", { addressed: ["bot"], reply_in_thread: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("saves changed metadata promptly after an in-flight PUT is rejected", async () => {
    let reject!: (error: unknown) => void;
    const put = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ ...row("ask", 1), meta: { addressed: ["bot"], reply_in_thread: false }, client_id: draftSync.clientId });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "ask");
    const saving = draftSync.flush("general");
    const textVersion = draftSync.version("general");
    draftSync.editMeta("general", { addressed: ["bot"], reply_in_thread: false });
    expect(draftSync.version("general")).toBe(textVersion);
    reject(new ApiError(403, "Old settings rejected"));
    await saving;
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith("/api/drafts", expect.objectContaining({ meta: { addressed: ["bot"], reply_in_thread: false } }));
  });

  it("flushes a cleared draft when backgrounded", async () => {
    const put = vi.fn(async (path: string, payload: { body: string }) => ({ ...row(payload.body, 2), body: payload.body || null, client_id: draftSync.clientId }));
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.applyRemote({ ...row("saved", 1), type: "draft" });
    draftSync.edit("general", "");
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    draftSync.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "" }));
  });

  it("retries an offline save while idle", async () => {
    const put = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ...row("offline text", 1), client_id: draftSync.clientId });
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "offline text");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("retries a transient 503 within two seconds", async () => {
    const put = vi.fn().mockRejectedValueOnce(new ApiError(503, "busy"))
      .mockResolvedValueOnce({ ...row("hello", 1), client_id: draftSync.clientId });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "hello");
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("retries a dirty draft on reconnect without another edit", async () => {
    const put = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ...row("unsent", 1), client_id: draftSync.clientId });
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "unsent");
    await draftSync.flush("general");
    expect(put).toHaveBeenCalledTimes(1);
    draftSync.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected 403 blocked until the API client changes", async () => {
    const put = vi.fn().mockRejectedValueOnce(new ApiError(403, "Expired"))
      .mockResolvedValueOnce({ ...row("unsynced", 1), client_id: draftSync.clientId });
    const first = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(first, true);
    draftSync.edit("general", "unsynced");
    await draftSync.flush("general");
    expect(put).toHaveBeenCalledTimes(1);
    draftSync.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("retries a blocked 403 when access changes on another device", async () => {
    const put = vi.fn().mockRejectedValueOnce(new ApiError(403, "No access"))
      .mockResolvedValueOnce({ ...row("unsynced", 1), client_id: draftSync.clientId });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "unsynced");
    await draftSync.flush("general");
    const qc = new QueryClient();
    applyWsEvent(qc, { type: "drafts_refresh", channel_id: "general", group_id: null, force: true }, { username: "ana" });
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(2);
    qc.clear();
  });

  it("flushes the previous conversation when switching", async () => {
    const put = vi.fn(async () => ({ ...row("first", 1), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.setActive("general");
    draftSync.edit("general", "first");
    draftSync.setActive("other");
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ channel_id: "general", body: "first" }));
  });

  it("does not arm a save timer on an older server", async () => {
    const put = vi.fn();
    draftSync.configure({ get: vi.fn(), put } as unknown as ApiClient, false);
    draftSync.edit("general", "local only");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put).not.toHaveBeenCalled();
  });

  it("flushes edits made before the capability response arrived", async () => {
    const put = vi.fn(async () => ({ ...row("early", 1), client_id: draftSync.clientId }));
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, false);
    draftSync.edit("general", "early");
    draftSync.configure(api, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "early" }));
  });

  it("keeps unsynced text when the same account renews its API client", () => {
    const first = { get: vi.fn(async () => ({ items: [] })) } as unknown as ApiClient;
    const renewed = { get: vi.fn(async () => ({ items: [] })) } as unknown as ApiClient;
    draftSync.configure(first, true);
    draftSync.edit("general", "offline text");
    draftSync.configure(renewed, true);
    expect(useMessageDrafts.getState().byConvo.general).toBe("offline text");
  });

  it("resends an unsynced key after 401 and a same-user API renewal", async () => {
    const rejected = vi.fn(async () => { throw new ApiError(401, "Expired"); });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put: rejected } as unknown as ApiClient, true);
    draftSync.edit("general", "do not lose this");
    await draftSync.flush("general");
    const put = vi.fn(async () => ({ ...row("do not lose this", 1), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useMessageDrafts.getState().byConvo.general).toBe("do not lose this");
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "do not lose this" }));
  });

  it("retries a 401 that arrives after the API client is renewed", async () => {
    let reject!: (error: unknown) => void;
    const oldPut = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put: oldPut } as unknown as ApiClient, true);
    draftSync.edit("general", "still mine");
    const pending = draftSync.flush("general");
    const put = vi.fn(async () => ({ ...row("still mine", 1), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    reject(new ApiError(401, "Expired"));
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "still mine" }));
  });

  it("applies remote text when clean and keeps unsent local edits", () => {
    draftSync.applyRemote({ ...row("from phone", 1), type: "draft" });
    expect(useMessageDrafts.getState().byConvo.general).toBe("from phone");
    draftSync.edit("general", "local edit");
    draftSync.applyRemote({ ...row("from phone again", 2), type: "draft" });
    expect(useMessageDrafts.getState().byConvo.general).toBe("local edit");
    draftSync.applyRemote({ ...row("old", 1), type: "draft" });
    expect(useMessageDrafts.getState().byConvo.general).toBe("local edit");
  });

  it("keeps a tombstone ahead of delayed saves and accepts a newer draft", () => {
    draftSync.applyRemote({ ...row("first", 1), type: "draft" });
    draftSync.applyRemote({ ...row("", 2), type: "draft", body: null });
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    draftSync.applyRemote({ ...row("delayed", 1), type: "draft" });
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    draftSync.applyRemote({ ...row("next", 3), type: "draft" });
    expect(useMessageDrafts.getState().byConvo.general).toBe("next");
    draftSync.applyRemote({ ...row("", 4), type: "draft", body: null, meta: {} as DraftRow["meta"] });
    expect(useMessageDrafts.getState().metaByConvo.general).toEqual({ addressed: [], reply_in_thread: false });
  });

  it("keeps local Talk-to and reply settings after a remote delete", () => {
    draftSync.applyRemote({ ...row("ask", 1), type: "draft", meta: { addressed: ["bot"], reply_in_thread: true } });
    draftSync.applyRemote({ ...row("", 2), type: "draft", body: null, meta: {} as DraftRow["meta"] });
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    expect(useAddressed.getState().byConvo.general).toEqual(["bot"]);
    expect(useMessageDrafts.getState().metaByConvo.general).toEqual({ addressed: ["bot"], reply_in_thread: true });
  });

  it("ignores an event written by this client", () => {
    draftSync.applyRemote({ ...row("own echo", 1), type: "draft", client_id: draftSync.clientId });
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("routes draft WebSocket events through the reducer", () => {
    const qc = new QueryClient();
    applyWsEvent(qc, { ...row("from socket", 1), type: "draft" }, { username: "ana" });
    expect(useMessageDrafts.getState().byConvo.general).toBe("from socket");
    qc.clear();
  });

  it("applies remote Talk-to and reply settings with a non-empty draft", () => {
    draftSync.applyRemote({ ...row("ask", 1), type: "draft", meta: { addressed: ["bot"], reply_in_thread: true } });
    expect(useAddressed.getState().byConvo.general).toEqual(["bot"]);
    expect(useMessageDrafts.getState().metaByConvo.general.reply_in_thread).toBe(true);
  });

  it("cleans an in-flight save that lands after the post outcome", async () => {
    let resolvePut!: (value: unknown) => void;
    const put = vi.fn(() => new Promise(resolve => { resolvePut = resolve; }));
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 3), body: null } }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "hello");
    const saving = draftSync.flush("general");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    const sent = draftSync.onSent("general", "hello", version,
      { deleted: true, row: { ...row("", 1), body: null } });
    resolvePut({ ...row("hello", 2), client_id: draftSync.clientId });
    await saving; await sent;
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 2 }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("cleans a late own save even when the post saw another device's draft", async () => {
    let release!: (value: unknown) => void;
    const put = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 4), body: null } }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "sent");
    const saving = draftSync.flush("general");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "sent", version);
    const finished = draftSync.onSent("general", "sent", version,
      { deleted: false, row: row("phone text", 2) });
    release({ ...row("sent", 3), client_id: draftSync.clientId });
    await saving; await finished;
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 3 }));
  });

  it("deletes a partial save of earlier text that lands after the post", async () => {
    let release!: (value: unknown) => void;
    let server = "";
    const put = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const del = vi.fn(async (_path: string, payload: { if_rev: number }) => {
      expect(payload.if_rev).toBe(2);
      server = "";
      return { deleted: true, draft: { ...row("", 3), body: null } };
    });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "hel");
    const saving = draftSync.flush("general");
    draftSync.edit("general", "hello");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    const sent = draftSync.onSent("general", "hello", version,
      { deleted: true, row: { ...row("", 1), body: null } });
    server = "hel";
    release({ ...row("hel", 2), client_id: draftSync.clientId });
    await saving; await sent;
    expect(server).toBe("");
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("cleans an in-flight save when the post found no draft row", async () => {
    let release!: (value: unknown) => void;
    let server = "";
    const put = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const del = vi.fn(async (_path: string, payload: { if_rev: number }) => {
      expect(payload.if_rev).toBe(1);
      server = "";
      return { deleted: true, draft: { ...row("", 2), body: null } };
    });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "hello");
    const saving = draftSync.flush("general");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    const sent = draftSync.onSent("general", "hello", version, { deleted: false, row: null });
    server = "hello";
    release({ ...row("hello", 1), client_id: draftSync.clientId });
    await saving; await sent;
    expect(server).toBe("");
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("cleans an own save whose response arrived before send cleanup", async () => {
    const put = vi.fn(async () => ({ ...row("hello", 5), client_id: draftSync.clientId }));
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 6), body: null } }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "hello");
    await draftSync.flush("general");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    await draftSync.onSent("general", "hello", version, { deleted: false, row: null });
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 5 }));
  });

  it("saves text typed while send cleanup is deleting an old draft", async () => {
    let finishDelete!: (value: unknown) => void;
    const del = vi.fn(() => new Promise(resolve => { finishDelete = resolve; }));
    const put = vi.fn(async () => ({ ...row("follow-up", 7), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("hello", 5), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    const sending = draftSync.onSent("general", "hello", version,
      { deleted: false, row: { ...row("hello", 5), client_id: draftSync.clientId } });
    draftSync.edit("general", "follow-up");
    finishDelete({ deleted: true, draft: { ...row("", 6), body: null } });
    await sending;
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "follow-up" }));
  });

  it("keeps sent text out of the composer while a failed cleanup delete retries", async () => {
    const del = vi.fn().mockRejectedValueOnce(new ApiError(503, "Server busy"))
      .mockResolvedValueOnce({ deleted: true, draft: { ...row("", 6), body: null } });
    const get = vi.fn(async () => ({ items: [row("sent", 5)] }));
    draftSync.configure({ get, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("sent", 5), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "sent", version);
    await draftSync.onSent("general", "sent", version,
      { deleted: false, row: { ...row("sent", 5), client_id: draftSync.clientId } });
    await draftSync.hydrate();
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenLastCalledWith("/api/drafts", expect.objectContaining({ if_rev: 5 }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("does not retry an old account's cleanup after resetAll", async () => {
    let rejectDelete!: (error: unknown) => void;
    const anaDelete = vi.fn(() => new Promise((_resolve, reject) => { rejectDelete = reject; }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [row("Ana's draft", 1)] })), delete: anaDelete } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("Ana's draft", 1), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "Ana's draft", version);
    const sending = draftSync.onSent("general", "Ana's draft", version,
      { deleted: false, row: { ...row("Ana's draft", 1), client_id: draftSync.clientId } });

    draftSync.resetAll();
    const bobDelete = vi.fn();
    draftSync.configure({ get: vi.fn(async () => ({ items: [row("Bob's draft", 1)] })), delete: bobDelete } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("Bob's draft", 1), type: "draft" });
    rejectDelete(new ApiError(503, "Ana's request failed"));
    await sending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(anaDelete).toHaveBeenCalledTimes(1);
    expect(bobDelete).not.toHaveBeenCalled();
    expect(useMessageDrafts.getState().byConvo.general).toBe("Bob's draft");
  });

  it("retries cleanup with its original revision after another device saves", async () => {
    let rejectDelete!: (error: unknown) => void;
    const del = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDelete = reject; }))
      .mockResolvedValueOnce({ deleted: false, draft: null });
    const phone = row("phone text", 2);
    const put = vi.fn(async () => ({ ...phone, rev: 3, client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [phone] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("sent", 1), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "sent", version);
    const sending = draftSync.onSent("general", "sent", version,
      { deleted: false, row: { ...row("sent", 1), client_id: draftSync.clientId } });
    draftSync.applyRemote({ ...phone, type: "draft" });
    rejectDelete(new ApiError(503, "Retry later"));
    await sending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenNthCalledWith(2, "/api/drafts", expect.objectContaining({ if_rev: 1 }));
    expect(useMessageDrafts.getState().byConvo.general).toBe("phone text");
  });

  it("applies another device's newer draft from the post response", async () => {
    const put = vi.fn(async () => ({ ...row("mine", 1), client_id: draftSync.clientId }));
    const del = vi.fn();
    let items: DraftRow[] = [];
    draftSync.configure({ get: vi.fn(async () => ({ items })), put, delete: del } as unknown as ApiClient, true);
    draftSync.edit("general", "mine");
    await draftSync.flush("general");
    const version = draftSync.version("general");
    items = [row("phone's newer text", 2)];
    draftSync.clearForSend("general", "mine", version);
    await draftSync.onSent("general", "mine", version,
      { deleted: false, row: row("phone's newer text", 2) });
    expect(useMessageDrafts.getState().byConvo.general).toBe("phone's newer text");
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps a deferred newer draft after a send", async () => {
    const put = vi.fn(async () => ({ ...row("mine", 1), client_id: draftSync.clientId }));
    let items: DraftRow[] = [];
    draftSync.configure({ get: vi.fn(async () => ({ items })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "mine");
    await draftSync.flush("general");
    draftSync.edit("general", "mine more");
    items = [row("phone text", 2)];
    draftSync.applyRemote({ ...row("phone text", 2), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "mine more", version);
    await draftSync.onSent("general", "mine more", version,
      { deleted: false, row: row("phone text", 2) });
    expect(useMessageDrafts.getState().byConvo.general).toBe("phone text");
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("conditionally deletes our own stale partial PUT of sent text", async () => {
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 3), body: null } }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("hello", 1), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    await draftSync.onSent("general", "hello", version,
      { deleted: false, row: { ...row("hello", 2), client_id: draftSync.clientId } });
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 2 }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("uses no cleanup request with an older server response", async () => {
    const del = vi.fn();
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("sent", 1), type: "draft" });
    await draftSync.onSent("general", "sent", draftSync.version("general"));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });

  it("leaves reply toggle management to the composer after a send", async () => {
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })) } as unknown as ApiClient, true);
    draftSync.edit("general", "hello", { addressed: [], reply_in_thread: false });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    draftSync.editMeta("general", { addressed: [], reply_in_thread: true });
    await draftSync.onSent("general", "hello", version,
      { deleted: true, row: { ...row("", 2), body: null } });
    expect(useMessageDrafts.getState().metaByConvo.general.reply_in_thread).toBe(true);
  });

  it("clears a sent attachment caption after a Talk-to change", async () => {
    const put = vi.fn();
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "see attached");
    const version = draftSync.version("general");
    draftSync.editMeta("general", { addressed: ["bot"], reply_in_thread: false });
    expect(draftSync.version("general")).toBe(version);
    draftSync.clearForSend("general", "see attached", version);
    await draftSync.onSent("general", "see attached", version,
      { deleted: true, row: { ...row("", 1), body: null } });
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    expect(put).not.toHaveBeenCalled();
  });

  it("saves the same text if it is typed again after send cleanup", async () => {
    const put = vi.fn(async () => ({ ...row("ok", 2), client_id: draftSync.clientId }));
    const del = vi.fn(async () => ({ deleted: false, draft: null }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("ok", 1), type: "draft" });
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "ok", version);
    await draftSync.onSent("general", "ok", version);
    draftSync.edit("general", "ok");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ body: "ok" }));
  });

  it("restores a failed send and merges text typed while it was pending", () => {
    draftSync.edit("general", "sent");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "sent", version);
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    draftSync.restoreFailedSend("general", "sent", version);
    expect(useMessageDrafts.getState().byConvo.general).toBe("sent");
    draftSync.clearForSend("general", "sent", draftSync.version("general"));
    draftSync.edit("general", "new text");
    draftSync.restoreFailedSend("general", "sent", version);
    expect(useMessageDrafts.getState().byConvo.general).toBe("sent new text");
  });

  it("restores a failed send after typing and erasing during the request", () => {
    draftSync.edit("general", "hello");
    const version = draftSync.version("general");
    draftSync.clearForSend("general", "hello", version);
    draftSync.edit("general", "x");
    draftSync.edit("general", "");
    draftSync.restoreFailedSend("general", "hello", version);
    expect(useMessageDrafts.getState().byConvo.general).toBe("hello");
  });

  it("keeps reply-in-thread off when typing continues after a send", async () => {
    draftSync.edit("general", "q1", { addressed: [], reply_in_thread: true });
    const sentVersion = draftSync.version("general");
    draftSync.clearForSend("general", "q1", sentVersion);
    draftSync.editMeta("general", { addressed: [], reply_in_thread: false });
    draftSync.edit("general", "q2");
    await draftSync.onSent("general", "q1", sentVersion);
    expect(useMessageDrafts.getState().byConvo.general).toBe("q2");
    expect(useMessageDrafts.getState().metaByConvo.general.reply_in_thread).toBe(false);
  });

  it("discards the server row and local composer text", async () => {
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 2), type: "draft", body: null } }));
    const api = { get: vi.fn(async () => ({ items: [] })), delete: del } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.applyRemote({ ...row("saved", 1), type: "draft" });
    expect(await draftSync.discard("general", 1)).toBe(true);
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ channel_id: "general", if_rev: 1 }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("keeps local text and refreshes when discard loses a revision race", async () => {
    let items = [row("original", 1)];
    const get = vi.fn(async () => ({ items }));
    const del = vi.fn(async () => ({ deleted: false, draft: null }));
    draftSync.configure({ get, delete: del } as unknown as ApiClient, true);
    await draftSync.hydrate();
    items = [row("newer device edit", 2)];
    expect(await draftSync.discard("general", 1)).toBe(false);
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 1 }));
    expect(useMessageDrafts.getState().byConvo.general).toBe("newer device edit");
    expect(useMessageDrafts.getState().rows[0].rev).toBe(2);
  });

  it("discards pre-existing unsynced text without recreating the draft", async () => {
    const put = vi.fn(async () => { throw new ApiError(503, "Offline"); });
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 4), type: "draft", body: null } }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("old", 3), type: "draft" });
    draftSync.edit("general", "old plus new text");
    await draftSync.flush("general");
    expect(await draftSync.discard("general", 3)).toBe(true);
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps text typed while discard is in flight", async () => {
    let resolve!: (value: unknown) => void;
    const del = vi.fn(() => new Promise(value => { resolve = value; }));
    const put = vi.fn(async () => ({ ...row("new text", 5), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("old", 3), type: "draft" });
    const pending = draftSync.discard("general", 3);
    await vi.advanceTimersByTimeAsync(0);
    draftSync.edit("general", "new text");
    resolve({ deleted: true, draft: { ...row("", 4), type: "draft", body: null } });
    await pending;
    expect(useMessageDrafts.getState().byConvo.general).toBe("new text");
  });

  it("does not recreate a discarded draft after a no-op metadata edit", async () => {
    let resolve!: (value: unknown) => void;
    const del = vi.fn(() => new Promise(value => { resolve = value; }));
    const put = vi.fn();
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("old", 3), type: "draft" });
    const version = draftSync.version("general");
    const pending = draftSync.discard("general", 3);
    draftSync.editMeta("general", { addressed: [], reply_in_thread: false });
    expect(draftSync.version("general")).toBe(version);
    resolve({ deleted: true, draft: { ...row("", 4), body: null } });
    await pending;
    await vi.advanceTimersByTimeAsync(800);
    expect(put).not.toHaveBeenCalled();
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("ignores a stale list response that started before discard", async () => {
    let release!: (value: unknown) => void;
    const get = vi.fn().mockResolvedValueOnce({ items: [] })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const del = vi.fn(async () => ({ deleted: true, draft: { ...row("", 2), body: null } }));
    draftSync.configure({ get, delete: del } as unknown as ApiClient, true);
    await vi.advanceTimersByTimeAsync(0);
    useMessageDrafts.getState().setDraft("general", "old");
    useMessageDrafts.getState().setRows([row("old", 1)]);
    const pending = draftSync.hydrate();
    expect(await draftSync.discard("general", 1)).toBe(true);
    release({ items: [row("old", 1)] });
    await pending;
    expect(useMessageDrafts.getState().rows).toEqual([]);
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(3);
    expect(useMessageDrafts.getState().loading).toBe(false);
  });

  it("re-arms a dirty save after discard fails on the network", async () => {
    const put = vi.fn(async () => ({ ...row("edited", 4), client_id: draftSync.clientId }));
    const del = vi.fn(async () => { throw new TypeError("Offline"); });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("old", 3), type: "draft" });
    draftSync.edit("general", "edited");
    await expect(draftSync.discard("general", 3)).rejects.toThrow("Offline");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalled();
  });

  it("drops a stale inbox row when discard reports a missing channel", async () => {
    const get = vi.fn(async () => ({ items: [] }));
    const del = vi.fn(async () => { throw new ApiError(404, "Channel gone"); });
    draftSync.configure({ get, delete: del } as unknown as ApiClient, true);
    useMessageDrafts.getState().setRows([row("old", 1)]);
    expect(await draftSync.discard("general", 1)).toBe(true);
    expect(useMessageDrafts.getState().rows).toEqual([]);
    expect(get).toHaveBeenCalled();
  });

  it("retries an inaccessible discard when its row returns at the same revision", async () => {
    let items: DraftRow[] = [];
    const del = vi.fn().mockRejectedValueOnce(new ApiError(403, "No access"))
      .mockResolvedValueOnce({ deleted: true, draft: { ...row("", 2), body: null } });
    draftSync.configure({ get: vi.fn(async () => ({ items })), delete: del } as unknown as ApiClient, true);
    useMessageDrafts.getState().setRows([row("old", 1)]);
    expect(await draftSync.discard("general", 1)).toBe(true);
    items = [row("old", 1)];
    await draftSync.hydrate(true);
    expect(del).toHaveBeenCalledTimes(2);
    expect(useMessageDrafts.getState().rows).toEqual([]);
  });

  it("removes a clean composer draft missing from hydration", async () => {
    let items: DraftRow[] = [row("saved", 1)];
    const api = { get: vi.fn(async () => ({ items })) } as unknown as ApiClient;
    draftSync.configure(api, true);
    await draftSync.hydrate();
    expect(useMessageDrafts.getState().byConvo.general).toBe("saved");
    items = [];
    await draftSync.hydrate();
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
  });

  it("reapplies the same revision when a missing draft returns to the list", async () => {
    let items: DraftRow[] = [row("back soon", 5)];
    draftSync.configure({ get: vi.fn(async () => ({ items })) } as unknown as ApiClient, true);
    await draftSync.hydrate();
    items = [];
    await draftSync.hydrate();
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    items = [row("back soon", 5)];
    await draftSync.hydrate();
    expect(useMessageDrafts.getState().byConvo.general).toBe("back soon");
  });

  it("keeps sticky Talk-to and reply settings after a draft is pruned", async () => {
    let items: DraftRow[] = [row("hello", 3)];
    items[0].meta = { addressed: ["bot"], reply_in_thread: true };
    const put = vi.fn(async () => ({ ...row("next", 4), client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items })), put } as unknown as ApiClient, true);
    await draftSync.hydrate();
    items = [];
    await draftSync.hydrate();
    draftSync.edit("general", "next");
    await draftSync.flush("general");
    expect(put).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({
      meta: { addressed: ["bot"], reply_in_thread: true },
    }));
  });

  it("reserves keepalive capacity for only the first large draft", async () => {
    const put = vi.fn(async (_path: string, payload: { channel_id: string; body: string }) =>
      ({ ...row(payload.body, 1), channel_id: payload.channel_id, client_id: draftSync.clientId }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("first", "é".repeat(20_000));
    draftSync.edit("second", "é".repeat(20_000));
    draftSync.flushAll({ keepalive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenNthCalledWith(1, "/api/drafts", expect.objectContaining({ channel_id: "first" }), { keepalive: true });
    expect(put).toHaveBeenNthCalledWith(2, "/api/drafts", expect.objectContaining({ channel_id: "second" }));
  });

  it("does not duplicate an in-flight save on unload", async () => {
    let release!: (value: unknown) => void;
    const put = vi.fn(() => new Promise(resolve => { release = resolve; }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "same");
    const saving = draftSync.flush("general");
    draftSync.edit("general", "newer text");
    draftSync.flushAll({ keepalive: true });
    expect(put).toHaveBeenCalledTimes(1);
    release({ ...row("same", 1), client_id: draftSync.clientId });
    await saving;
    expect(useMessageDrafts.getState().byConvo.general).toBe("newer text");
  });

  it("does not charge a blocked draft against the unload keepalive budget", async () => {
    const put = vi.fn(async (_path: string, payload: { channel_id: string; body: string }) => {
      if (payload.channel_id === "blocked") throw new ApiError(400, "Too long");
      return { ...row(payload.body, 1), channel_id: payload.channel_id, client_id: draftSync.clientId };
    });
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("blocked", "é".repeat(20_000));
    await draftSync.flush("blocked");
    draftSync.edit("sendable", "é".repeat(20_000));
    draftSync.flushAll({ keepalive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenLastCalledWith("/api/drafts", expect.objectContaining({ channel_id: "sendable" }), { keepalive: true });
  });

  it("ignores a late save response after resetAll", async () => {
    let resolve!: (value: unknown) => void;
    const put = vi.fn(() => new Promise(value => { resolve = value; }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient, true);
    draftSync.edit("general", "old account");
    const pending = draftSync.flush("general");
    draftSync.resetAll();
    resolve({ ...row("old account", 1), client_id: draftSync.clientId });
    await pending;
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
    expect(useMessageDrafts.getState().rows).toEqual([]);
  });

  it("ignores a late discard response after resetAll", async () => {
    let resolve!: (value: unknown) => void;
    const del = vi.fn(() => new Promise(value => { resolve = value; }));
    draftSync.configure({ get: vi.fn(async () => ({ items: [] })), delete: del } as unknown as ApiClient, true);
    draftSync.applyRemote({ ...row("old account", 1), type: "draft" });
    const pending = draftSync.discard("general", 1);
    draftSync.resetAll();
    useMessageDrafts.getState().setDraft("general", "new account");
    resolve({ deleted: true, draft: { ...row("", 2), body: null, type: "draft" } });
    expect(await pending).toBe(false);
    expect(useMessageDrafts.getState().byConvo.general).toBe("new account");
  });

  it("keeps local text after permission is revoked", async () => {
    const api = { get: vi.fn(async () => ({ items: [] })), put: vi.fn(async () => { throw new ApiError(403, "No access"); }) } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "keep me");
    await draftSync.flush("general");
    expect(useMessageDrafts.getState().byConvo.general).toBe("keep me");
    await draftSync.flush("general");
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it("keeps edits made after Send even if the text matches again", async () => {
    draftSync.edit("general", "same text");
    const version = draftSync.version("general");
    draftSync.edit("general", "new text");
    draftSync.edit("general", "same text");
    await draftSync.onSent("general", "same text", version);
    expect(useMessageDrafts.getState().byConvo.general).toBe("same text");
  });
});
