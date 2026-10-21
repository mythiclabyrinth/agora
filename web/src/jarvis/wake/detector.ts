/* Main-thread API for the on-device "Hey Agora" wake word.

     const wake = createWakeDetector({ onWake: (d) => ..., onScore: (s) => ... });
     await wake.start();               // or start(stream) / start({ deviceId })
     wake.holdOff(1500);               // while Agora itself is speaking
     wake.setArmed(false);             // e.g. during a live voice session
     wake.stop();

   Audio capture runs in an AudioWorklet (resampled to 16 kHz mono there) and
   is posted straight to a worker that runs the TFLM frontend, an energy gate
   and the model (wake.worker.ts). The wasm runtime and the model are fetched
   by the worker on start(), so none of this weighs on the main bundle.

   start() must follow a user gesture where the browser requires one for an
   AudioContext (Safari / WKWebView) and needs a secure origin for the mic. */

import wasmUrl from "./runtime/wake.wasm?url";
import workletUrl from "./capture.worklet.ts?worker&url";
import type { WakeDetection } from "./engine";
import type { FromWorker, ToWorker, WakeModelSpec, WakeScore, WakeStats } from "./protocol";
import type { VadOptions } from "./vad";

export type { WakeDetection } from "./engine";
export type { WakeScore, WakeStats, WakeModelSpec } from "./protocol";

const base = import.meta.env.BASE_URL;

/** Models shipped in web/public/wake (manifests beside them; see docs/JARVIS_WAKE.md). */
export const WAKE_MODELS = {
  hey_agora: { id: "hey_agora", phrase: "Hey Agora", url: `${base}wake/hey_agora.tflite`, window: 5, arena: 30000, cutoff: 0.95 },
  hey_jarvis: { id: "hey_jarvis", phrase: "Hey Jarvis", url: `${base}wake/hey_jarvis.tflite`, window: 5, arena: 22860, cutoff: 0.9 },
} as const satisfies Record<string, WakeModelSpec & { cutoff: number }>;

export interface WakeDetectorOptions {
  onWake: (detection: WakeDetection) => void;
  /** About 10 times a second while running. */
  onScore?: (score: WakeScore) => void;
  /** Every 5 s: inference time and worker load. */
  onStats?: (stats: WakeStats) => void;
  onError?: (message: string) => void;
  /** The audio resumed after the "Audio is paused" onError (a user gesture). */
  onResume?: () => void;
  /** Defaults to Hey Agora. */
  model?: WakeModelSpec & { cutoff?: number };
  /** 0.5-0.99; defaults to the model's own cutoff. */
  cutoff?: number;
  /** Energy gate options, or false to run the model on every step. */
  vad?: VadOptions | false;
  /** Extra getUserMedia audio constraints. */
  constraints?: MediaTrackConstraints;
}

export type WakeSource = MediaStream | { deviceId?: string } | undefined;

export interface WakeDetector {
  /** Opens the mic (or uses `stream`, which stop() then leaves running) and starts listening. */
  start(source?: WakeSource): Promise<void>;
  stop(): void;
  setCutoff(cutoff: number): void;
  /** Deaf for `ms` (only ever extends), e.g. while Agora speaks: there is no echo cancellation in the loop. */
  holdOff(ms: number): void;
  setArmed(armed: boolean): void;
  readonly running: boolean;
}

export function createWakeDetector(options: WakeDetectorOptions): WakeDetector {
  const model = options.model ?? WAKE_MODELS.hey_agora;
  let cutoff = options.cutoff ?? model.cutoff ?? 0.95;
  let armed = true;
  let generation = 0; // bumped by stop(), so a start() still in flight gives up
  let session: {
    ac: AudioContext;
    worker: Worker;
    node: AudioWorkletNode;
    source: MediaStreamAudioSourceNode;
    stream: MediaStream;
    ownsStream: boolean;
  } | null = null;

  const send = (msg: ToWorker, transfer: Transferable[] = []) => session?.worker.postMessage(msg, transfer);

  function stop() {
    generation++;
    if (!session) return;
    const s = session;
    session = null;
    s.worker.postMessage({ type: "stop" } satisfies ToWorker);
    s.source.disconnect();
    s.node.disconnect();
    void s.ac.close();
    if (s.ownsStream) s.stream.getTracks().forEach((t) => t.stop());
  }

  async function start(source?: WakeSource) {
    if (session) return;
    const gen = ++generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("The microphone needs a secure origin (https or localhost).");
    }
    let stream: MediaStream;
    let ownsStream = true;
    if (source instanceof MediaStream) {
      stream = source;
      ownsStream = false;
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: source?.deviceId ? { exact: source.deviceId } : undefined,
          channelCount: 1,
          // Echo cancellation keeps Agora's own speech out where the browser
          // supports it; noise suppression would reshape the very spectrum
          // the model listens to, so it stays off.
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          ...options.constraints,
        },
      });
    }
    if (gen !== generation) {
      if (ownsStream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ac = new AudioContext({ latencyHint: "interactive" });
    try {
      await ac.audioWorklet.addModule(workletUrl);
      if (gen !== generation) throw new Error("stopped");
      const worker = new Worker(new URL("./wake.worker.ts", import.meta.url), { type: "module", name: "agora-wake" });
      const node = new AudioWorkletNode(ac, "agora-wake-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const src = ac.createMediaStreamSource(stream);
      src.connect(node);
      // Some engines only pull nodes that reach the destination; ours outputs silence.
      node.connect(ac.destination);
      const pipe = new MessageChannel();
      node.port.postMessage({ port: pipe.port1 }, [pipe.port1]);
      session = { ac, worker, node, source: src, stream, ownsStream };
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        if (msg.type === "wake") options.onWake(msg.detection);
        else if (msg.type === "score") options.onScore?.(msg.score);
        else if (msg.type === "stats") options.onStats?.(msg.stats);
        else if (msg.type === "error") options.onError?.(msg.message);
      };
      worker.onerror = (e) => options.onError?.(e.message || "wake worker failed");
      const spec: WakeModelSpec = { id: model.id, phrase: model.phrase, url: abs(model.url), window: model.window, arena: model.arena };
      send(
        { type: "init", wasmUrl: abs(wasmUrl), models: [spec], cutoff, vad: options.vad ?? {}, armed, audio: pipe.port2 },
        [pipe.port2],
      );
      if (ac.state === "suspended") {
        // Without a user gesture some engines (WebKit) keep the context
        // suspended and resume() never settles: resume on the next gesture.
        await Promise.race([ac.resume(), new Promise((r) => setTimeout(r, 500))]);
        if (ac.state === "suspended") {
          options.onError?.("Audio is paused until you click or press a key in the window.");
          const kick = () => {
            document.removeEventListener("pointerdown", kick, true);
            document.removeEventListener("keydown", kick, true);
            ac.resume().then(() => { if (gen === generation) options.onResume?.(); }, () => {});
          };
          document.addEventListener("pointerdown", kick, true);
          document.addEventListener("keydown", kick, true);
        }
      }
    } catch (err) {
      const cancelled = gen !== generation;
      if (session) stop();
      else {
        void ac.close();
        if (ownsStream) stream.getTracks().forEach((t) => t.stop());
      }
      if (!cancelled) throw err;
    }
  }

  return {
    start,
    stop,
    setCutoff(value) {
      cutoff = value;
      send({ type: "cutoff", cutoff: value });
    },
    holdOff(ms) {
      send({ type: "holdOff", ms });
    },
    setArmed(value) {
      armed = value;
      send({ type: "armed", armed: value });
    },
    get running() {
      return session !== null;
    },
  };
}

// Workers resolve relative URLs against their own script; hand them absolute ones.
function abs(url: string): string {
  return new URL(url, location.href).href;
}
