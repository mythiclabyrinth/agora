import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { registerConnection, unregisterConnection } from "./clients.ts";
import { resolveTarget, sendAgoraMedia } from "./outbound.ts";

describe("resolveTarget", () => {
  it("accepts the shapes core hands back", () => {
    expect(resolveTarget("c1")).toEqual({ channelId: "c1", threadId: null });
    expect(resolveTarget("channel:c1")).toEqual({ channelId: "c1", threadId: null });
    expect(resolveTarget("agora:channel:c1")).toEqual({ channelId: "c1", threadId: null });
  });

  it("keeps the thread from a conversation id", () => {
    expect(resolveTarget("c1:42")).toEqual({ channelId: "c1", threadId: 42 });
  });

  it("prefers an explicit thread id from the reply plan", () => {
    expect(resolveTarget("c1", 7)).toEqual({ channelId: "c1", threadId: 7 });
    expect(resolveTarget("c1:42", "7")).toEqual({ channelId: "c1", threadId: 7 });
  });

  it("falls back to the channel root when the thread id is unusable", () => {
    expect(resolveTarget("c1", "not-a-number")).toEqual({ channelId: "c1", threadId: null });
  });
});

describe("sendAgoraMedia", () => {
  it("rejects a non-image before reading the file", async () => {
    const readFile = vi.fn(async () => Buffer.from("pdf"));
    const connection = {
      client: { post: vi.fn() },
      account: { maxFileBytes: 1024 },
    } as never;
    registerConnection("default", connection);
    try {
      await expect(sendAgoraMedia({ to: "c1", mediaUrl: "/tmp/report.pdf", readFile }))
        .rejects.toThrow(/image attachments only/);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      unregisterConnection("default", connection);
    }
  });

  it("rejects redirected and oversized remote media before buffering", async () => {
    const post = vi.fn();
    const connection = { client: { post }, account: { maxFileBytes: 10 } } as never;
    registerConnection("default", connection);
    try {
      const fetchMock = vi.fn(async () => new Response(null, {
        status: 302, headers: { location: "https://evil.example/image.png" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(sendAgoraMedia({ to: "c1", mediaUrl: "https://safe.example/image.png" }))
        .rejects.toThrow(/redirected/);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
        headers: { "content-length": "100" },
      })));
      await expect(sendAgoraMedia({ to: "c1", mediaUrl: "https://safe.example/image.png" }))
        .rejects.toThrow(/file limit/);
      expect(post).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      unregisterConnection("default", connection);
    }
  });
});

describe("sendAgoraText", () => {
  it("posts text to the resolved thread", async () => {
    const post = vi.fn(async () => "request-1");
    const connection = {
      client: { post },
      account: { maxFileBytes: 1024 },
    } as never;
    registerConnection("default", connection);
    try {
      const { sendAgoraText } = await import("./outbound.ts");
      await expect(sendAgoraText({ to: "c1:42", text: "hello" })).resolves.toEqual({
        messageId: "request-1",
      });
      expect(post).toHaveBeenCalledWith({ channelId: "c1", threadId: 42, text: "hello" });
    } finally {
      unregisterConnection("default", connection);
    }
  });
});
