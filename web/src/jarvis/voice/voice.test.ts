import { describe, expect, it } from "vitest";
import { createEndpointer, frameRms, type EndpointEvent } from "./endpointer";
import { createSentenceChunker, MAX_SPOKEN_CHARS } from "./sentences";

/** Feed `ms` of a constant level at 50 ms ticks; returns the non-null events. */
function feed(ep: ReturnType<typeof createEndpointer>, clock: { t: number }, rms: number, ms: number, playing = false) {
  const events: EndpointEvent[] = [];
  for (let end = clock.t + ms; clock.t < end;) {
    clock.t += 50;
    const ev = ep.step(rms, clock.t, playing);
    if (ev) events.push(ev);
  }
  return events;
}

describe("endpointer", () => {
  it("starts on speech and ends after ~800 ms of silence", () => {
    const ep = createEndpointer();
    const clock = { t: 0 };
    expect(feed(ep, clock, 0.001, 500)).toEqual([]);
    expect(feed(ep, clock, 0.05, 1200)).toEqual(["start"]);
    expect(ep.speaking).toBe(true);
    expect(feed(ep, clock, 0.001, 700)).toEqual([]);
    expect(feed(ep, clock, 0.001, 150)).toEqual(["end"]);
    expect(ep.voicedMs).toBeGreaterThanOrEqual(1100);
  });

  it("keeps listening through short pauses between words", () => {
    const ep = createEndpointer();
    const clock = { t: 0 };
    feed(ep, clock, 0.05, 600);
    expect(feed(ep, clock, 0.001, 500)).toEqual([]);
    expect(feed(ep, clock, 0.05, 400)).toEqual([]);
    expect(feed(ep, clock, 0.001, 900)).toEqual(["end"]);
  });

  it("discards blips too short to be speech (never sends silent clips)", () => {
    const ep = createEndpointer();
    const clock = { t: 0 };
    expect(feed(ep, clock, 0.05, 150)).toEqual(["start"]);
    expect(feed(ep, clock, 0.001, 900)).toEqual(["discard"]);
  });

  it("stops at the max utterance length", () => {
    const ep = createEndpointer({ maxMs: 2000 });
    const clock = { t: 0 };
    expect(feed(ep, clock, 0.05, 2050)).toEqual(["start", "end"]);
  });

  it("barges in on sustained speech during playback, not on short echo", () => {
    const ep = createEndpointer();
    const clock = { t: 0 };
    feed(ep, clock, 0.001, 100, true);
    expect(feed(ep, clock, 0.05, 100, true)).toEqual([]);
    expect(feed(ep, clock, 0.001, 100, true)).toEqual([]);
    expect(feed(ep, clock, 0.05, 150, true)).toEqual(["barge"]);
    // The interruption is already an utterance in progress.
    expect(ep.speaking).toBe(true);
    expect(feed(ep, clock, 0.05, 400)).toEqual([]);
    expect(feed(ep, clock, 0.001, 900)).toEqual(["end"]);
  });

  it("computes frame RMS", () => {
    expect(frameRms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });
});

describe("sentence chunker", () => {
  it("emits sentences as they complete, with offsets into the answer", () => {
    const c = createSentenceChunker();
    const full = "Two threads need you. The release thread is waiting on your sign-off! Anything else?";
    const got = [...c.push("Two threads need"), ...c.push(" you. The release"), ...c.push(" thread is waiting on your sign-off! Any"), ...c.push("thing else?")];
    expect(got.map(s => s.text)).toEqual(["Two threads need you.", "The release thread is waiting on your sign-off!"]);
    const rest = c.flush();
    expect(rest.map(s => s.text)).toEqual(["Anything else?"]);
    for (const s of [...got, ...rest]) expect(full.slice(s.start, s.end)).toBe(s.text);
  });

  it("does not split abbreviations, decimals or mid-word punctuation", () => {
    const c = createSentenceChunker();
    const out = c.push("Ask Dr. Lee about v1.0.28 e.g. the deploy. Done. ");
    expect(out.map(s => s.text)).toEqual(["Ask Dr. Lee about v1.0.28 e.g. the deploy.", "Done."]);
    expect(c.flush()).toEqual([]);
  });

  it("splits on newlines and skips punctuation-only fragments", () => {
    const c = createSentenceChunker();
    expect(c.push("First line\n... \nSecond line").map(s => s.text)).toEqual(["First line"]);
    expect(c.flush().map(s => s.text)).toEqual(["Second line"]);
  });

  it("handles quotes after the full stop", () => {
    const c = createSentenceChunker();
    expect(c.push('Drafted it for #release: "rerun the deploy." Send it?').map(s => s.text))
      .toEqual(['Drafted it for #release: "rerun the deploy."']);
    expect(c.flush().map(s => s.text)).toEqual(["Send it?"]);
  });
});

describe("endpointer reset", () => {
  it("does not charge the gap before a reset to the next utterance", () => {
    const e = createEndpointer();
    e.step(0, 0);
    e.step(0, 50);
    e.reset();
    expect(e.step(0.05, 300)).toBe("start");
    e.step(0.05, 350);
    expect(e.voicedMs).toBe(50);
  });
});

describe("long sentences", () => {
  it("cuts a run-on read-back into speakable pieces whose offsets index the answer", () => {
    const body = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ") + ", and then " +
      Array.from({ length: 60 }, (_, i) => `more${i}`).join(" ");
    const answer = `Drafted it for #release: "${body}". Send it?`;
    const c = createSentenceChunker();
    const parts = [...c.push(answer), ...c.flush()];
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(answer.slice(p.start, p.end)).toBe(p.text);
    }
    expect(parts.at(-1)?.text).toBe("Send it?");
    expect(parts.map(p => p.text).join(" ").replace(/\s+/g, " ")).toBe(answer.replace(/\s+/g, " "));
  });
});

describe("sentences in other scripts", () => {
  const all = (chunks: string[]) => {
    const c = createSentenceChunker();
    const out = chunks.flatMap(ch => c.push(ch));
    return { out, rest: c.flush(), full: chunks.join("") };
  };
  const offsetsHold = (r: ReturnType<typeof all>) => {
    for (const s of [...r.out, ...r.rest]) expect(r.full.slice(s.start, s.end)).toBe(s.text);
  };

  it("splits Chinese and Japanese on full stops with no space after", () => {
    const r = all(["今天发布。", "你要发送吗？好的"]);
    expect(r.out.map(s => s.text)).toEqual(["今天发布。", "你要发送吗？"]);
    expect(r.rest.map(s => s.text)).toEqual(["好的"]);
    offsetsHold(r);
    const j = all(["こんにちは。元気ですか！", "またね"]);
    expect([...j.out, ...j.rest].map(s => s.text)).toEqual(["こんにちは。", "元気ですか！", "またね"]);
  });

  it("waits for punctuation split across chunks, and keeps a closing quote with its sentence", () => {
    const r = all(["「送信しました", "。", "」次", "は？"]);
    expect(r.out.map(s => s.text)).toEqual(["「送信しました。」"]);
    expect(r.rest.map(s => s.text)).toEqual(["次は？"]);
    offsetsHold(r);
    const l = all(["Sent it", ".", " Next"]);
    expect(l.out.map(s => s.text)).toEqual(["Sent it."]);
    offsetsHold(l);
  });

  it("splits Hindi on the danda, Arabic on its question mark, and full-width marks", () => {
    const hi = all(["संदेश भेज दिया। क्या कुछ और", "?"]);
    expect([...hi.out, ...hi.rest].map(s => s.text)).toEqual(["संदेश भेज दिया।", "क्या कुछ और?"]);
    offsetsHold(hi);
    const ar = all(["هل أرسلها؟ نعم"]);
    expect([...ar.out, ...ar.rest].map(s => s.text)).toEqual(["هل أرسلها؟", "نعم"]);
    const fw = all(["完了！次；最後"]);
    expect([...fw.out, ...fw.rest].map(s => s.text)).toEqual(["完了！", "次；", "最後"]);
  });

  it("keeps highlight offsets right around emoji and other surrogate pairs", () => {
    const r = all(["Done 🎉. Next 👍🏽 step! ", "𝒳 marks it."]);
    expect([...r.out, ...r.rest].map(s => s.text)).toEqual(["Done 🎉.", "Next 👍🏽 step!", "𝒳 marks it."]);
    offsetsHold(r);
  });

  it("cuts a long unspaced run without splitting a surrogate pair", () => {
    const text = "字".repeat(MAX_SPOKEN_CHARS - 1) + "😀" + "字".repeat(50);
    const r = all([text]);
    const parts = [...r.out, ...r.rest];
    expect(parts.length).toBe(2);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(/[\uD800-\uDBFF]$/.test(p.text)).toBe(false);
      expect(text.slice(p.start, p.end)).toBe(p.text);
    }
    expect(parts.map(p => p.text).join("")).toBe(text);
  });
});
