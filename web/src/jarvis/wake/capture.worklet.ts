/* AudioWorklet: mic in, 16 kHz mono int16 out, posted straight to the wake
   worker over a MessagePort the main thread hands us. Nothing else happens
   on the audio thread, and the main thread never sees the audio. Bundled by
   Vite as `?worker&url` (see detector.ts), so it may import the resampler. */

import { Resampler } from "./resampler";

// The AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const POST_SAMPLES = 480; // 30 ms at 16 kHz: one stride-3 inference

class WakeCaptureProcessor extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate);
  private out: MessagePort | null = null;
  private buf = new Int16Array(POST_SAMPLES * 4);
  private fill = 0;
  private mono = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ port?: MessagePort }>) => {
      if (e.data.port) this.out = e.data.port;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || !channels.length || !this.out) return true;
    const n = channels[0].length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    if (channels.length === 1) this.mono.set(channels[0]);
    else {
      this.mono.fill(0);
      for (const ch of channels) for (let i = 0; i < n; i++) this.mono[i] += ch[i] / channels.length;
    }
    const pcm = this.resampler.process(this.mono);
    if (this.fill + pcm.length > this.buf.length) this.flush();
    this.buf.set(pcm, this.fill);
    this.fill += pcm.length;
    if (this.fill >= POST_SAMPLES) this.flush();
    return true;
  }

  private flush() {
    if (!this.fill || !this.out) return;
    const chunk = this.buf.slice(0, this.fill);
    this.out.postMessage(chunk, [chunk.buffer]);
    this.fill = 0;
  }
}

registerProcessor("agora-wake-capture", WakeCaptureProcessor);
