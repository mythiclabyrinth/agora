/* Node-only helpers for the wake tests: load wake.wasm and the shipped
   models from disk and push audio through the same engine the worker runs. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WakeEngine, type EngineOptions, type WakeDetection } from "./engine";
import { loadWakeRuntime, type WakeRuntime } from "./runtime";
import { toInt16 } from "./resampler";
import { parseWav } from "./wav";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const WASM_PATH = here("./runtime/wake.wasm");
export const FIXTURES = here("./__fixtures__/");
export const MODEL_DIR = here("../../../public/wake/");

export const MODELS = {
  hey_agora: { phrase: "Hey Agora", window: 5, arena: 30000, cutoff: 0.95 },
  hey_jarvis: { phrase: "Hey Jarvis", window: 5, arena: 22860, cutoff: 0.9 },
} as const;
export type ModelId = keyof typeof MODELS;

let wasmModule: WebAssembly.Module | null = null;
export async function freshRuntime(): Promise<WakeRuntime> {
  wasmModule ??= new WebAssembly.Module(readFileSync(WASM_PATH));
  return loadWakeRuntime(wasmModule);
}

export interface RunResult {
  detections: WakeDetection[];
  /** Highest window mean seen, 0-1. */
  maxScore: number;
  modelSteps: number;
  inferenceMs: number;
  totalMs: number;
  audioMs: number;
}

/** A fresh runtime + engine per clip (as a page load would be), fed in 30 ms chunks like the worklet posts. */
export async function runClip(
  pcm: Int16Array,
  id: ModelId,
  options: EngineOptions = {},
): Promise<RunResult> {
  const rt = await freshRuntime();
  const spec = MODELS[id];
  const model = rt.loadModel(readFileSync(`${MODEL_DIR}${id}.tflite`), spec.arena);
  let inferenceMs = 0;
  const engine = new WakeEngine(
    rt,
    [{ id, phrase: spec.phrase, stride: model.stride, window: spec.window, invoke: (f) => model.invoke(f) }],
    { cutoff: spec.cutoff, ...options },
  );
  const detections: WakeDetection[] = [];
  let maxScore = 0;
  const started = performance.now();
  for (let at = 0; at < pcm.length; at += 480) {
    detections.push(...engine.feed(pcm.subarray(at, at + 480)));
    maxScore = Math.max(maxScore, engine.score);
    const s = engine.takeStats();
    if (s) inferenceMs += s.meanMs * s.steps;
  }
  const totalMs = performance.now() - started;
  return { detections, maxScore, modelSteps: engine.modelSteps, inferenceMs, totalMs, audioMs: (pcm.length / 16000) * 1000 };
}

/** The highest sliding-window sum (0-255 * window) a model reaches over a
 *  clip after the 1 s warm-up, with no detection policy: lets the eval sweep
 *  cutoffs offline. A clip detects at cutoff c iff maxSum > round(c*255)*window. */
export async function maxWindowSum(pcm: Int16Array, id: ModelId): Promise<number> {
  const rt = await freshRuntime();
  const spec = MODELS[id];
  const model = rt.loadModel(readFileSync(`${MODEL_DIR}${id}.tflite`), spec.arena);
  const { frames, quant } = rt.process(pcm);
  const input = new Int8Array(model.stride * 40);
  const probs = new Array<number>(spec.window).fill(0);
  let sum = 0;
  let k = 0;
  let best = 0;
  for (let f = 0, step = 0; f < frames; f++) {
    input.set(quant.subarray(f * 40, f * 40 + 40), step * 40);
    if (++step < model.stride) continue;
    step = 0;
    const p = model.invoke(input);
    sum += p - probs[k];
    probs[k] = p;
    k = (k + 1) % spec.window;
    if (f >= 100) best = Math.max(best, sum);
  }
  model.free();
  return best;
}

/** A 16 kHz WAV as int16 (exact for 16-bit files). */
export function readPcm16(path: string): Int16Array {
  const wav = parseWav(readFileSync(path));
  if (wav.sampleRate !== 16000) throw new Error(`${path}: ${wav.sampleRate} Hz, expected 16000`);
  return toInt16(wav.samples);
}
