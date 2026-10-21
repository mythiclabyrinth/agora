/* End-to-end over the real wasm runtime and the shipped models: committed
   WAV fixtures through frontend -> quantize -> model -> detection policy. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/golden-features.json";
import { Resampler } from "./resampler";
import { FIXTURES, MODEL_DIR, freshRuntime, readPcm16, runClip } from "./testkit";
import { parseWav } from "./wav";

const fixture = (name: string) => readPcm16(`${FIXTURES}${name}`);

describe("wake.wasm frontend", () => {
  it.each(Object.entries(golden))(
    "%s: features match the ESP32 desk's vendored microfrontend bit for bit",
    async (name, want) => {
      const rt = await freshRuntime();
      const pcm = fixture(name);
      // Arbitrary chunking must not change the output (the worklet posts 30 ms; the firmware 10 ms).
      const raw: number[] = [];
      for (let at = 0; at < pcm.length; at += 333) raw.push(...rt.process(pcm.subarray(at, at + 333)).raw);
      const bytes = Buffer.from(Uint16Array.from(raw).buffer);
      expect(raw.length / 40).toBe(want.frames);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(want.sha256);
    },
  );

  it("quantizes as Wake.cpp: q = (v * 256 + 333) / 666 - 128, clamped", async () => {
    const rt = await freshRuntime();
    const out = rt.process(fixture("hey_agora_samantha.wav"));
    for (let i = 0; i < out.raw.length; i++) {
      const q = Math.trunc((out.raw[i] * 256 + 333) / 666) - 128;
      expect(out.quant[i]).toBe(Math.max(-128, Math.min(127, q)));
    }
  });
});

describe("wake.wasm models", () => {
  it("loads both shipped models with the microWakeWord contract", async () => {
    const rt = await freshRuntime();
    for (const [id, arena] of [["hey_agora", 30000], ["hey_jarvis", 22860]] as const) {
      const m = rt.loadModel(readFileSync(`${MODEL_DIR}${id}.tflite`), arena);
      expect(m.stride).toBe(3);
      expect(m.arenaUsed).toBeGreaterThan(0);
      expect(m.arenaUsed).toBeLessThanOrEqual(arena);
      m.free();
    }
  });

  it("rejects a file that is not a model", async () => {
    const rt = await freshRuntime();
    expect(() => rt.loadModel(new Uint8Array(4096), 30000)).toThrow(/not loaded/);
  });
});

describe("detection", () => {
  it.each(["hey_agora_samantha.wav", "hey_agora_daniel.wav"])("hears Hey Agora in %s once", async (name) => {
    const r = await runClip(fixture(name), "hey_agora");
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0].phrase).toBe("Hey Agora");
    // The crossing sits within the phrase, which starts at 1.2 s.
    expect(r.detections[0].samplePos / 16000).toBeGreaterThan(1.2);
    expect(r.detections[0].samplePos / 16000).toBeLessThan(3.0);
  });

  it.each(["hey_agora", "hey_jarvis"] as const)("%s stays quiet on ordinary speech", async (model) => {
    expect((await runClip(fixture("negatives.wav"), model)).detections).toEqual([]);
  });

  it("Hey Jarvis stays quiet on near misses (hey claude, agora, hey google)", async () => {
    expect((await runClip(fixture("near_misses.wav"), "hey_jarvis")).detections).toEqual([]);
  });

  // KNOWN MODEL ISSUE, not a pipeline bug: the current Hey Agora model fires
  // on "hey <two syllables>" and on "agora" alone (docs/JARVIS_WAKE.md has
  // the corpus numbers). Marked `fails` so a retrained model that fixes it
  // flips this test and prompts removing the marker.
  it.fails("Hey Agora stays quiet on near misses (known to fail with the current model)", async () => {
    expect((await runClip(fixture("near_misses.wav"), "hey_agora")).detections).toEqual([]);
  });

  it("Hey Jarvis (the ESPHome reference model) works through the same pipeline", async () => {
    expect((await runClip(fixture("hey_jarvis_karen.wav"), "hey_jarvis")).detections).toHaveLength(1);
    expect((await runClip(fixture("hey_agora_samantha.wav"), "hey_jarvis")).detections).toEqual([]);
    expect((await runClip(fixture("hey_jarvis_karen.wav"), "hey_agora")).detections).toEqual([]);
  });

  it("the energy gate idles the model in silence without changing the outcome", async () => {
    // Replaying the pre-roll keeps the result close to always-on inference;
    // not bit-identical, since frames older than the pre-roll never reach
    // the model's streaming state.
    for (const name of ["hey_agora_samantha.wav", "hey_agora_daniel.wav", "negatives.wav", "near_misses.wav"]) {
      const pcm = fixture(name);
      const gated = await runClip(pcm, "hey_agora");
      const always = await runClip(pcm, "hey_agora", { vad: false });
      expect(gated.detections.length).toBe(always.detections.length);
      gated.detections.forEach((d, i) => {
        expect(Math.abs(d.samplePos - always.detections[i].samplePos)).toBeLessThanOrEqual(1600); // 100 ms
      });
      expect(gated.modelSteps).toBeLessThanOrEqual(always.modelSteps);
    }
    // A long silent stretch runs no model steps at all once the gate shuts.
    const silence = new Int16Array(16000 * 10).map((_, i) => ((i * 7919) % 41) - 20);
    const idle = await runClip(silence, "hey_agora");
    expect(idle.modelSteps).toBeLessThan(40);
  });

  it("survives resampling from 48 kHz and 44.1 kHz capture", async () => {
    const wav = parseWav(readFileSync(`${FIXTURES}hey_agora_samantha.wav`));
    for (const rate of [48000, 44100]) {
      // Upsample with the resampler itself (16k -> rate isn't what it's for,
      // so use linear interpolation), then come back down through it.
      const n = Math.floor((wav.samples.length * rate) / 16000);
      const up = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = (i * 16000) / rate;
        const k = Math.floor(t);
        const f = t - k;
        up[i] = (wav.samples[k] ?? 0) * (1 - f) + (wav.samples[k + 1] ?? 0) * f;
      }
      const rs = new Resampler(rate);
      const parts: Int16Array[] = [];
      for (let at = 0; at < up.length; at += 128) parts.push(rs.process(up.subarray(at, at + 128)));
      const pcm = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
      let at = 0;
      for (const p of parts) {
        pcm.set(p, at);
        at += p.length;
      }
      expect(Math.abs(pcm.length - wav.samples.length)).toBeLessThan(40);
      expect((await runClip(pcm, "hey_agora")).detections).toHaveLength(1);
    }
  });
});
