/* Messages between the main thread (detector.ts) and the wake worker. */

import type { VadOptions } from "./vad";
import type { WakeDetection } from "./engine";

export interface WakeModelSpec {
  id: string;
  phrase: string;
  /** URL of the .tflite flatbuffer. */
  url: string;
  /** The manifest's sliding_window_size. */
  window: number;
  /** The manifest's tensor_arena_size. */
  arena: number;
}

export type ToWorker =
  | {
      type: "init";
      wasmUrl: string;
      models: WakeModelSpec[];
      cutoff: number;
      vad: VadOptions | false;
      armed: boolean;
      /** 16 kHz int16 chunks from the capture worklet. */
      audio: MessagePort;
    }
  | { type: "armed"; armed: boolean }
  | { type: "holdOff"; ms: number }
  | { type: "cutoff"; cutoff: number }
  | { type: "stop" };

export interface WakeScore {
  /** Best smoothed probability 0-1 (the window mean the cutoff applies to). */
  score: number;
  /** Highest single-step probability over the last 3 s. */
  peak: number;
  cutoff: number;
  /** Armed, not held off, not in the refractory period. */
  listening: boolean;
  /** The models are running (the energy gate is open). */
  active: boolean;
  /** Input level of the last 10 ms block, dBFS. */
  levelDb: number;
  /** Seconds of audio the worker has processed. */
  audioSec: number;
}

export interface WakeStats {
  /** Inference steps in the period (one per stride of 30 ms while active). */
  steps: number;
  meanMs: number;
  maxMs: number;
  /** Share of wall time the worker spent on audio (frontend + models), %. */
  workerBusyPct: number;
  /** Share of the period the models were running, %. */
  activePct: number;
}

export type FromWorker =
  | { type: "ready"; models: { id: string; stride: number; arenaUsed: number }[] }
  | { type: "score"; score: WakeScore }
  | { type: "wake"; detection: WakeDetection }
  | { type: "stats"; stats: WakeStats }
  | { type: "error"; message: string };
