/* End-of-speech detection for the assistant's voice loop, as a pure state
   machine over mic RMS samples (the same gate live voice uses: an RMS
   threshold, ~800 ms of trailing silence, short blips dropped). The caller
   polls the analyser every ~50 ms and acts on the returned event:

     "start"   speech began: start recording
     "end"     the utterance finished: stop and send it
     "discard" it finished but held too little voice: stop and drop it
     "barge"   sustained speech while the assistant is talking: stop the
               playback and treat it as a new utterance (already started) */

export interface EndpointerOptions {
  /** RMS speech threshold on the mic signal. */
  threshold?: number;
  /** The utterance ends after this much quiet. */
  silenceMs?: number;
  /** Less voiced time than this is a cough or a key click: discarded. */
  minVoicedMs?: number;
  /** Hard stop for one utterance. */
  maxMs?: number;
  /** Voiced time during playback that counts as an interruption. */
  bargeMs?: number;
}

export type EndpointEvent = "start" | "end" | "discard" | "barge" | null;

export const ENDPOINT_DEFAULTS: Required<EndpointerOptions> = {
  threshold: 0.015,
  silenceMs: 800,
  minVoicedMs: 300,
  maxMs: 30_000,
  bargeMs: 150,
};

export interface Endpointer {
  /** One RMS sample at `now` ms; `playing` while the assistant's audio plays. */
  step(rms: number, now: number, playing?: boolean): EndpointEvent;
  /** Forget any utterance in progress (e.g. capture was cancelled). */
  reset(): void;
  readonly speaking: boolean;
  /** Voiced milliseconds in the current (or last) utterance. */
  readonly voicedMs: number;
}

export function createEndpointer(options: EndpointerOptions = {}): Endpointer {
  const o = { ...ENDPOINT_DEFAULTS, ...options };
  let speaking = false;
  let startedAt = 0;
  let lastVoice = 0;
  let voiced = 0;
  let bargeRun = 0;
  let lastAt: number | null = null;

  const begin = (now: number, already: number) => {
    speaking = true;
    startedAt = now - already;
    lastVoice = now;
    voiced = already;
  };

  return {
    step(rms, now, playing = false) {
      const dt = lastAt == null ? 0 : Math.max(0, Math.min(250, now - lastAt));
      lastAt = now;
      const loud = rms >= o.threshold;
      if (playing) {
        // While the assistant talks only an interruption counts; echo that
        // leaks past the browser's cancellation is short and patchy.
        speaking = false;
        bargeRun = loud ? bargeRun + dt : 0;
        if (bargeRun >= o.bargeMs) {
          const run = bargeRun;
          bargeRun = 0;
          begin(now, run);
          return "barge";
        }
        return null;
      }
      bargeRun = 0;
      if (!speaking) {
        if (!loud) return null;
        begin(now, 0);
        return "start";
      }
      if (loud) {
        lastVoice = now;
        voiced += dt;
      }
      if (now - startedAt >= o.maxMs || now - lastVoice >= o.silenceMs) {
        speaking = false;
        return voiced >= o.minVoicedMs ? "end" : "discard";
      }
      return null;
    },
    reset() {
      speaking = false;
      bargeRun = 0;
      voiced = 0;
    },
    get speaking() { return speaking; },
    get voicedMs() { return voiced; },
  };
}

/** Root-mean-square of one analyser frame. */
export function frameRms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}
