import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { cancelJarvisDraft, clientClock, createSseParser, isDraftLikeCard, jarvisTranscribe, jarvisTurn, sendJarvisDraft, updateJarvisDraft, type JarvisEvent } from "./jarvis";

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

  it("edits, sends at a revision, and cancels drafts on their endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ApiClient({ baseUrl: "http://x", token: "t" });
    await updateJarvisDraft(api, "jd_1", "edited", 1);
    await sendJarvisDraft(api, "jd_1", 2);
    await cancelJarvisDraft(api, "jd_1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("http://x/api/jarvis/drafts/jd_1");
    expect(calls[0][1].method).toBe("PUT");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ text: "edited", revision: 1 });
    expect(calls[1][0]).toBe("http://x/api/jarvis/drafts/jd_1/send");
    expect(calls[1][1].method).toBe("POST");
    const sent = JSON.parse(calls[1][1].body as string);
    expect(sent.revision).toBe(2);
    expect(sent.text).toBeUndefined();
    expect(calls[2][0]).toBe("http://x/api/jarvis/drafts/jd_1");
    expect(calls[2][1].method).toBe("DELETE");
  });

  it("reports silence as a no-speech code, not an error", async () => {
    const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const session = { baseUrl: "http://x", token: "t" };
    vi.stubGlobal("fetch", reply({ text: "", no_speech: true }));
    expect(await jarvisTranscribe(session, new Blob(["a"]))).toEqual({ text: "", noSpeech: true });
    vi.stubGlobal("fetch", reply({ text: " hola, envíalo ", no_speech: false }));
    expect(await jarvisTranscribe(session, new Blob(["a"]))).toEqual({ text: "hola, envíalo", noSpeech: false });
  });
});

describe("clientClock", () => {
  it("reports minutes east of UTC and whether the zone shifts during the year", () => {
    const at = (offset: number, jan: number, jul: number) => {
      const d = new Date(2026, 9, 26);
      vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(function (this: Date) {
        return this.getTime() === d.getTime() ? offset : this.getMonth() === 0 ? jan : jul;
      });
      const { utc_offset_minutes, has_dst } = clientClock(d, 0);
      return { utc_offset_minutes, has_dst };
    };
    expect(at(-330, -330, -330)).toEqual({ utc_offset_minutes: 330, has_dst: false });
    expect(at(240, 300, 240)).toEqual({ utc_offset_minutes: -240, has_dst: true });
    expect(at(0, 0, 0)).toEqual({ utc_offset_minutes: 0, has_dst: false });
    vi.restoreAllMocks();
  });

  it("lists the zone's coming offset changes, pinned to the minute", () => {
    // New York: EDT until 2026-11-01 06:00 UTC, EST until 2027-03-14 07:00 UTC.
    const fallBack = Date.UTC(2026, 10, 1, 6);
    const springForward = Date.UTC(2027, 2, 14, 7);
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(function (this: Date) {
      const t = this.getTime();
      return t >= fallBack && t < springForward ? 300 : 240;
    });
    const clock = clientClock(new Date(Date.UTC(2026, 9, 25, 15, 17, 42, 123)));
    expect(clock.utc_offset_minutes).toBe(-240);
    expect(clock.tz_transitions).toEqual([
      { at_utc: fallBack / 1000, offset_minutes: -300 },
      { at_utc: springForward / 1000, offset_minutes: -240 },
    ]);
    vi.restoreAllMocks();
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);
    expect(clientClock(new Date(Date.UTC(2026, 9, 25))).tz_transitions).toEqual([]);
    vi.restoreAllMocks();
  });

  it("knows which cards are confirmable drafts", () => {
    expect(isDraftLikeCard({ kind: "schedules", items: [], total: 0, offset: 0, has_more: false, truncated: false })).toBe(false);
    expect(isDraftLikeCard({ kind: "digest", items: [] })).toBe(false);
    expect(isDraftLikeCard({ kind: "schedule_change" } as never)).toBe(true);
  });
});
