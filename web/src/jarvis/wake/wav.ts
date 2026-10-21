/* Minimal RIFF/WAVE reader (PCM 16-bit or float 32, any rate, any channel
   count, downmixed to mono) for feeding files through the wake pipeline in
   tests and the dev panel. */

export interface WavAudio {
  sampleRate: number;
  /** Mono samples, -1..1. */
  samples: Float32Array;
}

export function parseWav(bytes: ArrayBuffer | Uint8Array): WavAudio {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (at: number) => String.fromCharCode(u8[at], u8[at + 1], u8[at + 2], u8[at + 3]);
  if (u8.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let at = 12;
  while (at + 8 <= u8.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === "data") {
      if (!channels) throw new Error("WAV data before fmt");
      const len = Math.min(size, u8.length - body);
      const frameBytes = (bits / 8) * channels;
      const frames = Math.floor(len / frameBytes);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const off = body + i * frameBytes + (c * bits) / 8;
          if (format === 1 && bits === 16) sum += view.getInt16(off, true) / 32768;
          else if (format === 3 && bits === 32) sum += view.getFloat32(off, true);
          else throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bits)`);
        }
        samples[i] = sum / channels;
      }
      return { sampleRate, samples };
    }
    at = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

/** 16-bit mono PCM WAV bytes, for writing fixtures. */
export function encodeWav16(samples: Int16Array, sampleRate = 16000): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, samples.length * 2, true);
  new Int16Array(out.buffer, 44).set(samples);
  return out;
}
