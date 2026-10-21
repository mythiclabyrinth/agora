import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { cancelJarvisDraft, createSseParser, jarvisTurn, sendJarvisDraft, type JarvisEvent } from "./jarvis";

const frame = (event: JarvisEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function collect() {
  const events: JarvisEvent[] = [];
  return { events, parser: createSseParser(e => events.push(e)) };
}

describe("createSseParser", () => {
  it("parses whole frames and ignores comments", () => {
    const { events, parser } = collect();
    parser.push(": keepalive\n\n" + frame({ type: "status", phase: "thinking", label: "Thinking" }) + frame({ type: "delta", text: "Hi" }));
    parser.end();
    expect(events).toEqual([
      { type: "status", phase: "thinking", label: "Thinking" },
      { type: "delta", text: "Hi" },
    ]);
  });

  it("reassembles frames split at every byte, including inside UTF-8 characters", () => {
    const text = frame({ type: "delta", text: "Summarizing “release” — 2 threads 🧵" }) + frame({ type: "done", conversation_id: "jc_1", text: "ok" });
    const bytes = new TextEncoder().encode(text);
    const { events, parser } = collect();
    for (const b of bytes) parser.push(new Uint8Array([b]));
    parser.end();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "Summarizing “release” — 2 threads 🧵" });
    expect(events[1].type).toBe("done");
  });

  it("handles CRLF, multi-line data, a missing final blank line, and bad JSON", () => {
    const { events, parser } = collect();
    parser.push('event: card\r\ndata: {"type":"card",\r\ndata: "card":{"kind":"digest","items":[]}}\r\n\r\n');
    parser.push("data: {not json}\n\n");
    parser.push('data: {"type":"error","message":"boom"}');
    parser.end();
    expect(events).toEqual([
      { type: "card", card: { kind: "digest", items: [] } },
      { type: "error", message: "boom" },
    ]);
  });
});

describe("jarvisTurn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams events from a chunked response body", async () => {
    const chunks = [frame({ type: "start", conversation_id: "jc_9" }).slice(0, 10), frame({ type: "start", conversation_id: "jc_9" }).slice(10), frame({ type: "delta", text: "Two threads need you." })];
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const events: JarvisEvent[] = [];
    await jarvisTurn({ baseUrl: "http://x", token: "t" }, { text: "catch me up", context: { channel_id: "c1" } }, e => events.push(e));
    expect(events.map(e => e.type)).toEqual(["start", "delta"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/api/jarvis/turn");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(init.body as string)).toEqual({ text: "catch me up", context: { channel_id: "c1" } });
  });

  it("rejects with the server's detail on HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Jarvis mode needs ChatGPT" }), { status: 400 })));
    await expect(jarvisTurn({ baseUrl: "http://x", token: "t" }, { text: "hi" }, () => {}))
      .rejects.toMatchObject({ status: 400, message: "Jarvis mode needs ChatGPT" });
  });

  it("sends and cancels drafts on the confirm endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "http://x", token: "t" });
    await sendJarvisDraft(api, "jd_1", "edited");
    await cancelJarvisDraft(api, "jd_1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("http://x/api/jarvis/drafts/jd_1/send");
    expect(calls[0][1].method).toBe("POST");
    expect(JSON.parse(calls[0][1].body as string).text).toBe("edited");
    expect(calls[1][0]).toBe("http://x/api/jarvis/drafts/jd_1");
    expect(calls[1][1].method).toBe("DELETE");
  });
});
