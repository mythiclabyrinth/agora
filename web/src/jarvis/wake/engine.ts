/* The detection policy, ported from the ESP32 desk (Esp32Agent/Wake.cpp and
   Board.h) so a model behaves the same in Agora as on the board:

   - the frontend runs on every 10 ms block, even while deaf, so its noise
     estimate keeps up with the room; only the models wait;
   - each model collects `stride` feature frames per inference and keeps a
     sliding window of its uint8 probabilities; it "crosses" when the window
     sum exceeds cutoff * window (cutoff in the same 0-255 unit);
   - after (re-)arming, a warm-up of WARMUP_MS of features cannot detect,
     because the streaming state still holds old audio;
   - with several models, the first crossing waits ARBITRATE_MS for the
     others and the highest window mean wins (wakeArbitrate);
   - a detection resets the windows and starts a refractory period;
   - holdOff(ms) deafens it around sounds Agora itself makes (there is no
     echo cancellation in the loop).

   Added for the browser: an energy VAD gates the models (not the frontend).
   While the room is quiet the features go into a pre-roll ring instead; when
   the gate opens they are replayed through the models first, so the result
   matches always-on inference while costing nothing in silence.

   Time is counted in samples, never the wall clock, so a WAV file and a live
   mic go through exactly the same logic. */

import { FEATURES, SAMPLE_RATE, STEP_SAMPLES, type FrontendFrames } from "./runtime";
import { EnergyVad, type VadOptions } from "./vad";

// Board.h
export const WARMUP_MS = 1000;
export const REFRACTORY_MS = 2000;
export const ARBITRATE_MS = 150;
export const PEAK_HOLD_MS = 3000;
const STEP_MS = (STEP_SAMPLES * 1000) / SAMPLE_RATE;

export interface EngineFrontend {
  process(samples: Int16Array): FrontendFrames;
}

export interface EngineModel {
  id: string;
  phrase: string;
  stride: number;
  /** Probabilities averaged for the cutoff (the manifest's sliding_window_size). */
  window: number;
  invoke(features: Int8Array): number;
}

export interface EngineOptions {
  /** 0-1; Wake.cpp keeps it as round(cutoff * 255). Defaults to 0.95. */
  cutoff?: number;
  /** Energy gate; `false` runs the models on every step like the firmware. */
  vad?: VadOptions | false;
  /** Features kept while the gate is shut and replayed when it opens, ms. */
  preRollMs?: number;
  armed?: boolean;
  /** Clock for inference timing stats (performance.now). */
  now?: () => number;
}

export interface WakeDetection {
  id: string;
  phrase: string;
  /** Sample position (16 kHz, since the engine started) where the window crossed the cutoff. */
  samplePos: number;
  /** The winning window mean, 0-1. */
  score: number;
}

export interface InferenceStats {
  steps: number;
  meanMs: number;
  maxMs: number;
}

/** Index of the highest window mean among eligible models (ties go to the
 *  earlier one), compared without division as in Wake.h; -1 if none. */
export function wakeArbitrate(sums: number[], windows: number[], eligible: boolean[]): number {
  let best = -1;
  for (let i = 0; i < sums.length; i++) {
    if (!eligible[i] || !windows[i]) continue;
    if (best < 0 || sums[i] * windows[best] > sums[best] * windows[i]) best = i;
  }
  return best;
}

interface Detector {
  m: EngineModel;
  input: Int8Array;
  strideStep: number;
  probs: number[];
  probIndex: number;
  sum: number;
  crossPos: number; // sample position at the crossing; 0 not yet
}

export class WakeEngine {
  private readonly frontend: EngineFrontend;
  private readonly detectors: Detector[];
  private readonly vad: EnergyVad | null;
  private readonly preRollFrames: number;
  private readonly clock: () => number;

  private armedWanted: boolean;
  private _listening = false;
  private cutoffU8: number;
  private samplePos = 0;
  private holdUntilMs = 0;
  private refractoryUntilMs = 0;
  private warmup = 0;
  private arbitrateLeft = -1;
  private arbitratePos = 0;
  private _score = 0;
  private _peak = 0;
  private peakAtMs = 0;
  private pending = new Int16Array(0);
  private preRoll: Int8Array[] = [];
  private gateOpen = false;
  private statSteps = 0;
  private statMs = 0;
  private statMaxMs = 0;
  private _modelSteps = 0;

  constructor(frontend: EngineFrontend, models: EngineModel[], options: EngineOptions = {}) {
    if (!models.length) throw new Error("the wake engine needs at least one model");
    this.frontend = frontend;
    this.detectors = models.map((m) => ({
      m,
      input: new Int8Array(m.stride * FEATURES),
      strideStep: 0,
      probs: new Array<number>(Math.max(1, m.window)).fill(0),
      probIndex: 0,
      sum: 0,
      crossPos: 0,
    }));
    this.cutoffU8 = toU8(options.cutoff ?? 0.95);
    this.vad = options.vad === false ? null : new EnergyVad(options.vad ?? {});
    this.preRollFrames = Math.round((options.preRollMs ?? WARMUP_MS) / STEP_MS);
    this.armedWanted = options.armed ?? true;
    this.clock = options.now ?? (() => performance.now());
  }

  // --- control (the firmware's loop() side) ---
  setArmed(armed: boolean): void {
    this.armedWanted = armed;
  }
  /** Stay deaf for `ms` from now; only ever extends. */
  holdOff(ms: number): void {
    this.holdUntilMs = Math.max(this.holdUntilMs, this.nowMs + ms);
  }
  setCutoff(cutoff: number): void {
    this.cutoffU8 = toU8(cutoff);
  }

  // --- readouts ---
  get cutoff(): number {
    return this.cutoffU8 / 255;
  }
  /** Best smoothed probability 0-1 across the models. */
  get score(): number {
    return this._score / 255;
  }
  /** Highest single-step probability in the last PEAK_HOLD_MS. */
  get peak(): number {
    return this._peak / 255;
  }
  get listening(): boolean {
    return this._listening;
  }
  /** Whether the models are running (gate open, or no gate). */
  get active(): boolean {
    return this._listening && (this.vad === null || this.gateOpen);
  }
  get levelDb(): number {
    return this.vad?.levelDb ?? 0;
  }
  get nowMs(): number {
    return (this.samplePos * 1000) / SAMPLE_RATE;
  }
  /** Inference steps run since the start (for tests and duty-cycle stats). */
  get modelSteps(): number {
    return this._modelSteps;
  }
  /** Model time per step since the last call. */
  takeStats(): InferenceStats | null {
    if (!this.statSteps) return null;
    const out = { steps: this.statSteps, meanMs: this.statMs / this.statSteps, maxMs: this.statMaxMs };
    this.statSteps = this.statMs = this.statMaxMs = 0;
    return out;
  }

  // --- audio (the firmware's mic-task side) ---
  /** 16 kHz mono samples in any chunk size; returns detections decided in them. */
  feed(samples: Int16Array): WakeDetection[] {
    const out: WakeDetection[] = [];
    let buf = samples;
    if (this.pending.length) {
      buf = new Int16Array(this.pending.length + samples.length);
      buf.set(this.pending);
      buf.set(samples, this.pending.length);
    }
    let at = 0;
    for (; at + STEP_SAMPLES <= buf.length; at += STEP_SAMPLES) {
      const d = this.block(buf.subarray(at, at + STEP_SAMPLES));
      if (d) out.push(d);
    }
    this.pending = buf.slice(at);
    return out;
  }

  private block(block: Int16Array): WakeDetection | null {
    this.samplePos += block.length;
    const now = this.nowMs;
    let listen = this.armedWanted && now >= this.holdUntilMs && now >= this.refractoryUntilMs;
    if (listen && !this._listening) {
      // Coming back from deafness: let the models run a while before a
      // detection counts.
      this.resetWindows();
      this.warmup = Math.round(WARMUP_MS / STEP_MS);
    }
    if (!listen && this._listening) {
      this._score = 0;
      this.arbitrateLeft = -1; // a detection still being decided is dropped
      this.preRoll = [];
    }
    this._listening = listen;

    const wasOpen = this.gateOpen;
    this.gateOpen = this.vad ? this.vad.push(block) : true;

    const frames = this.frontend.process(block);
    let detection: WakeDetection | null = null;
    for (let f = 0; f < frames.frames; f++) {
      const features = frames.quant.slice(f * FEATURES, (f + 1) * FEATURES);
      if (!listen) continue;
      if (!this.gateOpen) {
        this.preRoll.push(features);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        if (wasOpen) this._score = 0;
        continue;
      }
      const queue = this.preRoll.length ? [...this.preRoll, features] : [features];
      this.preRoll = [];
      for (const q of queue) {
        const winner = this.featureReady(q, now);
        if (winner >= 0) {
          const d = this.detectors[winner];
          detection = {
            id: d.m.id,
            phrase: d.m.phrase,
            samplePos: d.crossPos || this.arbitratePos,
            score: d.sum / d.m.window / 255,
          };
          this.resetWindows();
          this.refractoryUntilMs = now + REFRACTORY_MS;
          this._listening = false;
          listen = false;
          break;
        }
      }
    }
    return detection;
  }

  private resetWindows(): void {
    for (const d of this.detectors) {
      d.probs.fill(0);
      d.probIndex = 0;
      d.strideStep = 0;
      d.sum = 0;
      d.crossPos = 0;
    }
    this.arbitrateLeft = -1;
    this._score = 0;
    this._peak = 0;
  }

  // One feature frame in, to every model; the winner's index once a
  // detection is decided, else -1 (Wake.cpp featureReady).
  private featureReady(features: Int8Array, now: number): number {
    if (this.warmup) this.warmup--;
    const cutoff = this.cutoffU8;
    let spent = 0;
    let ran = false;
    for (const d of this.detectors) {
      d.input.set(features, FEATURES * d.strideStep);
      if (++d.strideStep < d.m.stride) continue;
      d.strideStep = 0;

      const started = this.clock();
      const p = d.m.invoke(d.input);
      spent += this.clock() - started;
      ran = true;
      if (p < 0) continue;
      // The first second after re-arming can spike on stale streaming state;
      // those steps cannot detect, so they do not count for the meter either.
      if (!this.warmup && (p >= this._peak || now - this.peakAtMs > PEAK_HOLD_MS)) {
        this._peak = p;
        this.peakAtMs = now;
      }
      const window = d.m.window;
      d.sum = d.sum - d.probs[d.probIndex] + p;
      d.probs[d.probIndex] = p;
      d.probIndex = (d.probIndex + 1) % window;
      if (!this.warmup && !d.crossPos && d.sum > cutoff * window) d.crossPos = this.samplePos || 1;
    }
    if (ran) {
      this._modelSteps++;
      this.statSteps++;
      this.statMs += spent;
      if (spent > this.statMaxMs) this.statMaxMs = spent;
    }

    const sums = this.detectors.map((d) => d.sum);
    const windows = this.detectors.map((d) => d.m.window);
    // The meter shows the best model; a detection only goes to one that is
    // above the cutoff right now (a model that crossed and fell back is out).
    const best = wakeArbitrate(sums, windows, this.detectors.map(() => true));
    this._score = best < 0 ? 0 : Math.floor(sums[best] / windows[best]);
    const winner = wakeArbitrate(sums, windows, this.detectors.map((d) => d.sum > cutoff * d.m.window));
    const crossed = this.detectors.some((d) => d.crossPos);
    if (this.warmup || !crossed) return -1;

    // The phrases share syllables ("hey"), so a model that crosses first may
    // not be the one that was said: give the others a moment, then take the
    // most confident. A single model has no one to wait for.
    if (this.arbitrateLeft < 0) {
      this.arbitratePos = this.samplePos;
      this.arbitrateLeft = this.detectors.length > 1 ? Math.round(ARBITRATE_MS / STEP_MS) : 0;
    }
    if (this.arbitrateLeft > 0) {
      this.arbitrateLeft--;
      return -1;
    }
    this.arbitrateLeft = -1;
    if (winner < 0) {
      // Every crossing fell back below the cutoff while it was being decided.
      for (const d of this.detectors) d.crossPos = 0;
      return -1;
    }
    return winner;
  }
}

function toU8(cutoff: number): number {
  const c = Math.min(0.99, Math.max(0.5, cutoff));
  return Math.round(c * 255);
}
