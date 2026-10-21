/* The detection policy against a scripted fake frontend and model, so each
   rule ported from Wake.cpp is pinned down without audio. */

import { describe, expect, it } from "vitest";
import { WakeEngine, wakeArbitrate, type EngineModel } from "./engine";
import type { FrontendFrames } from "./runtime";
import { EnergyVad, rmsDb } from "./vad";
import { Resampler } from "./resampler";

// One feature frame per 160-sample block, carrying the block's first sample
// as feature 0 so the fake model can tell frames apart.
const frontend = {
  process(samples: Int16Array): FrontendFrames {
    const frames = Math.floor(samples.length / 160);
    const quant = new Int8Array(frames * 40);
    for (let f = 0; f < frames; f++) quant[f * 40] = Math.max(-128, Math.min(127, samples[f * 160] >> 8));
    return { frames, raw: new Uint16Array(frames * 40), quant };
  },
};

/** A model whose probability follows `script(step)`; stride 3 like the real ones. */
function scripted(id: string, script: (step: number) => number, stride = 3): EngineModel & { steps: number } {
  const m = {
    id,
    phrase: id,
    stride,
    window: 5,
    steps: 0,
    invoke: (_f: Int8Array) => script(m.steps++),
  };
  return m;
}

const loud = (ms: number) => new Int16Array(ms * 16).fill(8000);
const quiet = (ms: number) => new Int16Array(ms * 16);
const msOfStep = (step: number) => step * 30;

describe("WakeEngine policy (Wake.cpp)", () => {
  it("fires once the window sum passes cutoff * window, strictly", () => {
    // 242 * 5 = 1210 is the line at 0.95; five 242s sit on it and do not fire.
    const on = scripted("a", (s) => (s >= 40 && s < 45 ? 242 : s >= 60 && s < 65 ? 243 : 0));
    const e = new WakeEngine(frontend, [on], { vad: false });
    const d = e.feed(loud(3000));
    expect(d).toHaveLength(1);
    // Fires on the fifth 243 (step 64), i.e. at the end of its 30 ms stride.
    expect(d[0].samplePos).toBe((msOfStep(64) + 30) * 16);
    expect(d[0].score).toBeCloseTo(243 / 255, 5);
  });

  it("ignores everything during the 1 s warm-up after arming", () => {
    const m = scripted("a", (s) => (s < 30 ? 255 : 0)); // 30 steps = 900 ms of 255s
    const e = new WakeEngine(frontend, [m], { vad: false });
    expect(e.feed(loud(3000))).toEqual([]);
    expect(e.peak).toBe(0); // warm-up steps do not count for the meter either
  });

  it("goes deaf for 2 s after a detection (refractory) and then warms up again", () => {
    const m = scripted("a", () => 255);
    const e = new WakeEngine(frontend, [m], { vad: false });
    const d = e.feed(loud(6000));
    // First at warm-up end + 5 steps; then 2 s refractory + 1 s warm-up + 5 steps.
    expect(d).toHaveLength(2);
    expect(d[1].samplePos - d[0].samplePos).toBeGreaterThanOrEqual(3000 * 16);
  });

  it("holdOff deafens for at least that long and only ever extends", () => {
    const m = scripted("a", () => 255);
    const e = new WakeEngine(frontend, [m], { vad: false });
    e.holdOff(4000);
    e.holdOff(500); // must not shorten the 4 s hold
    const d = e.feed(loud(6000));
    expect(d).toHaveLength(1);
    expect(d[0].samplePos).toBeGreaterThan((4000 + 1000) * 16);
  });

  it("setArmed(false) stops detection; re-arming warms up first", () => {
    const m = scripted("a", () => 255);
    const e = new WakeEngine(frontend, [m], { vad: false, armed: false });
    expect(e.feed(loud(3000))).toEqual([]);
    expect(e.listening).toBe(false);
    expect(m.steps).toBe(0); // models do not run while deaf
    e.setArmed(true);
    const d = e.feed(loud(3000));
    expect(d).toHaveLength(1);
    expect(d[0].samplePos).toBeGreaterThan((3000 + 1000) * 16);
  });

  it("setCutoff moves the line (clamped to 0.5-0.99)", () => {
    const m = scripted("a", (s) => (s > 40 ? 200 : 0));
    const strict = new WakeEngine(frontend, [m], { vad: false });
    expect(strict.feed(loud(3000))).toEqual([]);
    const m2 = scripted("a", (s) => (s > 40 ? 200 : 0));
    const lax = new WakeEngine(frontend, [m2], { vad: false });
    lax.setCutoff(0.75);
    expect(lax.cutoff).toBeCloseTo(191 / 255, 5);
    expect(lax.feed(loud(3000))).toHaveLength(1);
    lax.setCutoff(5);
    expect(lax.cutoff).toBeCloseTo(252 / 255, 5);
  });

  it("with two models, waits 150 ms after the first crossing and picks the higher mean", () => {
    const hey = scripted("hey_claude", (s) => (s >= 40 ? 250 : 0));
    const other = scripted("hey_agora", (s) => (s >= 42 ? 255 : 0));
    const e = new WakeEngine(frontend, [hey, other], { vad: false });
    const d = e.feed(loud(3000));
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe("hey_agora");
  });

  it("wakeArbitrate compares means without division; ties go to the earlier model", () => {
    expect(wakeArbitrate([1000, 1200], [5, 5], [true, true])).toBe(1);
    expect(wakeArbitrate([1000, 1000], [5, 5], [true, true])).toBe(0);
    expect(wakeArbitrate([1000, 600], [5, 3], [true, true])).toBe(0); // 200 vs 200: tie
    expect(wakeArbitrate([1000, 1200], [5, 5], [true, false])).toBe(0);
    expect(wakeArbitrate([1000], [0], [true])).toBe(-1);
  });
});

describe("energy gate", () => {
  it("runs no model steps in silence and replays the pre-roll when sound starts", () => {
    const m = scripted("a", () => 0);
    const e = new WakeEngine(frontend, [m], {});
    e.feed(quiet(5000));
    expect(m.steps).toBe(0);
    expect(e.active).toBe(false);
    e.feed(loud(30));
    // 1 s of pre-roll (100 frames) + the live frames, at stride 3.
    expect(m.steps).toBeGreaterThanOrEqual(33);
    expect(e.active).toBe(true);
    // Hangover: still open 900 ms into silence, shut after 1.1 s.
    e.feed(quiet(900));
    expect(e.active).toBe(true);
    e.feed(quiet(200));
    expect(e.active).toBe(false);
  });

  it("learns a steady room level and opens on what stands out of it", () => {
    const vad = new EnergyVad();
    const hum = new Int16Array(160).map((_, i) => Math.round(300 * Math.sin(i / 3))); // ~-44 dBFS
    for (let i = 0; i < 1000; i++) vad.push(hum); // 10 s of hum
    expect(vad.open).toBe(false);
    expect(vad.noiseFloorDb).toBeCloseTo(rmsDb(hum), 0);
    expect(vad.push(hum.map((v) => v * 4))).toBe(true); // +12 dB
  });
});

describe("Resampler", () => {
  const tone = (rate: number, hz: number, sec: number) =>
    Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (x: Int16Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length) / 32768;

  it.each([48000, 44100, 96000, 16000])("%i Hz: keeps 1 kHz, drops 10 kHz, right length", (rate) => {
    for (const [hz, check] of [
      [1000, (r: number) => expect(r).toBeGreaterThan(0.34)],
      [10000, (r: number) => expect(r).toBeLessThan(0.01)],
    ] as const) {
      if (hz >= rate / 2) continue;
      const rs = new Resampler(rate);
      const x = tone(rate, hz, 1);
      const parts: Int16Array[] = [];
      for (let at = 0; at < x.length; at += 128) parts.push(rs.process(x.subarray(at, at + 128)));
      const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      expect(Math.abs(out.length - 16000)).toBeLessThan(40);
      check(rms(out.subarray(400)));
    }
  });
});
