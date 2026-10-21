/* The wake worker: loads wake.wasm and the model(s), takes 16 kHz audio
   from the capture worklet over a MessagePort, and runs the frontend, the
   energy gate and the models off the main thread. Posts a score readout a
   few times a second, detections at once, and timing stats every 5 s. */

import { WakeEngine, type EngineModel } from "./engine";
import { loadWakeRuntime } from "./runtime";
import type { FromWorker, ToWorker } from "./protocol";

const SCORE_EVERY_MS = 100;
const STATS_EVERY_MS = 5000;

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

let engine: WakeEngine | null = null;
let audio: MessagePort | null = null;
let busyMs = 0;
let activeBlocks = 0;
let blocks = 0;
let lastScoreAt = 0;
let statsFrom = performance.now();
let statsTimer: ReturnType<typeof setInterval> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init(msg: Extract<ToWorker, { type: "init" }>) {
  const [wasm, ...modelBytes] = await Promise.all([fetchBytes(msg.wasmUrl), ...msg.models.map((m) => fetchBytes(m.url))]);
  const runtime = await loadWakeRuntime(wasm);
  const loaded = msg.models.map((spec, i) => ({ spec, model: runtime.loadModel(modelBytes[i], spec.arena) }));
  const models: EngineModel[] = loaded.map(({ spec, model }) => ({
    id: spec.id,
    phrase: spec.phrase,
    stride: model.stride,
    window: spec.window,
    invoke: (f) => model.invoke(f),
  }));
  engine = new WakeEngine(runtime, models, { cutoff: msg.cutoff, vad: msg.vad, armed: msg.armed });
  audio = msg.audio;
  audio.onmessage = (e: MessageEvent<Int16Array>) => onAudio(e.data);
  statsTimer = setInterval(postStats, STATS_EVERY_MS);
  post({ type: "ready", models: loaded.map(({ spec, model }) => ({ id: spec.id, stride: model.stride, arenaUsed: model.arenaUsed })) });
}

function onAudio(chunk: Int16Array) {
  if (!engine) return;
  const started = performance.now();
  for (const detection of engine.feed(chunk)) post({ type: "wake", detection });
  busyMs += performance.now() - started;
  const n = Math.floor(chunk.length / 160);
  blocks += n;
  if (engine.active) activeBlocks += n;
  if (started - lastScoreAt >= SCORE_EVERY_MS) {
    lastScoreAt = started;
    post({
      type: "score",
      score: {
        score: engine.score,
        peak: engine.peak,
        cutoff: engine.cutoff,
        listening: engine.listening,
        active: engine.active,
        levelDb: engine.levelDb,
        audioSec: engine.nowMs / 1000,
      },
    });
  }
}

function postStats() {
  if (!engine) return;
  const now = performance.now();
  const stats = engine.takeStats();
  post({
    type: "stats",
    stats: {
      steps: stats?.steps ?? 0,
      meanMs: stats?.meanMs ?? 0,
      maxMs: stats?.maxMs ?? 0,
      workerBusyPct: (100 * busyMs) / Math.max(1, now - statsFrom),
      activePct: blocks ? (100 * activeBlocks) / blocks : 0,
    },
  });
  busyMs = 0;
  blocks = activeBlocks = 0;
  statsFrom = now;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      init(msg).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
      break;
    case "armed":
      engine?.setArmed(msg.armed);
      break;
    case "holdOff":
      engine?.holdOff(msg.ms);
      break;
    case "cutoff":
      engine?.setCutoff(msg.cutoff);
      break;
    case "stop":
      if (statsTimer) clearInterval(statsTimer);
      audio?.close();
      engine = null;
      self.close();
      break;
  }
};
