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

  it("waits for another edit after an offline save failure", async () => {
    const put = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ...row("edited again", 1), client_id: draftSync.clientId });
    const api = { get: vi.fn(async () => ({ items: [] })), put } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "offline text");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(put).toHaveBeenCalledTimes(1);
    draftSync.edit("general", "edited again");
    await vi.advanceTimersByTimeAsync(800);
    expect(put).toHaveBeenCalledTimes(2);
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

  it("waits for an in-flight save before post-send cleanup", async () => {
    let release!: (value: unknown) => void;
    const put = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const del = vi.fn(async () => ({ draft: { ...row("", 2), body: null } }));
    const api = { get: vi.fn(async () => ({ items: [] })), put, delete: del } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.edit("general", "hello");
    const saving = draftSync.flush("general");
    const sent = draftSync.onSent("general", "hello");
    expect(del).not.toHaveBeenCalled();
    release({ ...row("hello", 1), client_id: draftSync.clientId });
    await saving; await sent;
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ if_rev: 1 }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
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
    const del = vi.fn(async () => ({ draft: { ...row("", 2), type: "draft", body: null } }));
    const api = { get: vi.fn(async () => ({ items: [] })), delete: del } as unknown as ApiClient;
    draftSync.configure(api, true);
    draftSync.applyRemote({ ...row("saved", 1), type: "draft" });
    await draftSync.discard("general");
    expect(del).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ channel_id: "general" }));
    expect(useMessageDrafts.getState().byConvo.general).toBeUndefined();
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
