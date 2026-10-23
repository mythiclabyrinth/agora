import { describe, expect, it } from "vitest";
import { timeStretch, trimSilence } from "./stretch";

const SR = 24_000;
const tone = (seconds: number, hz = 220, amp = 0.3) =>
  Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

describe("trimSilence", () => {
  it("cuts the silence around the speech, keeping a short pad", () => {
    const clip = new Float32Array(SR * 2); // 0.5 s silence, 1 s sound, 0.5 s silence
    clip.set(tone(1), SR / 2);
    const [start, end] = trimSilence(clip, SR);
    expect(start / SR).toBeGreaterThan(0.4);
    expect(start / SR).toBeLessThan(0.5);
    expect(end / SR).toBeGreaterThan(1.5);
    expect(end / SR).toBeLessThan(1.6);
  });

  it("leaves an all-quiet clip whole", () => {
    expect(trimSilence(new Float32Array(1000), SR)).toEqual([0, 1000]);
  });
});

describe("timeStretch", () => {
  it("is shorter by the rate, finite, and no louder", () => {
    for (const rate of [1.25, 1.5, 1.75, 2]) {
      const input = tone(2);
      const out = timeStretch(input, rate, SR);
      expect(out.length / input.length).toBeCloseTo(1 / rate, 1);
      expect(out.every(Number.isFinite)).toBe(true);
      expect(Math.max(...out.map(Math.abs))).toBeLessThan(0.36);
    }
  });

  it("keeps the pitch: the zero-crossing rate of a tone is unchanged", () => {
    const crossings = (s: Float32Array) => { let n = 0; for (let i = 1; i < s.length; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++; return n / s.length; };
    const input = tone(2);
    const out = timeStretch(input, 1.5, SR);
    const mid = out.subarray(Math.round(out.length * 0.1), Math.round(out.length * 0.9));
    expect(crossings(mid) / crossings(input)).toBeCloseTo(1, 1);
  });

  it("passes a fragment shorter than one window through, and keeps the tail", () => {
    const short = new Float32Array(500).fill(0.3);
    expect(timeStretch(short, 1.5, SR)).toBe(short);
    const input = tone(1);
    const out = timeStretch(input, 1.5, SR);
    const tail = out.subarray(out.length - Math.round(SR * 0.02));
    expect(Math.max(...tail.map(Math.abs))).toBeGreaterThan(0.1); // the end still sounds
  });

  it("is a no-op at 1×", () => {
    const input = tone(0.5);
    expect(timeStretch(input, 1, SR)).toBe(input);
  });
});
