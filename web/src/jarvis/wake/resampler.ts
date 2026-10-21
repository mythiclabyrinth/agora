/* Streaming resampler to 16 kHz int16 for the wake word: a Blackman-windowed
   sinc low-pass (corner 7.2 kHz, below the frontend's 7.5 kHz top band) read
   at fractional positions from a precomputed phase table. Pure and
   allocation-light, so it runs inside the AudioWorklet and in Node tests. */

const OUT_RATE = 16000;
const PHASES = 1024;
const CUTOFF_HZ = 7200;

export class Resampler {
  readonly inRate: number;
  private readonly step: number; // input samples per output sample
  private readonly half: number; // filter half-width in input samples
  private readonly table: Float32Array | null; // PHASES+1 rows of 2*half taps
  private hist: Float32Array; // carried input, starting at index `base`
  private pos: number; // next output position, in input samples relative to hist[0]

  constructor(inRate: number) {
    if (!(inRate >= 8000)) throw new Error(`unsupported input rate ${inRate}`);
    this.inRate = inRate;
    this.step = inRate / OUT_RATE;
    if (inRate === OUT_RATE) {
      this.half = 0;
      this.table = null;
    } else {
      const fc = Math.min(CUTOFF_HZ, inRate * 0.45) / inRate; // cycles per input sample
      this.half = Math.ceil(12 * Math.max(1, this.step));
      const taps = 2 * this.half;
      this.table = new Float32Array((PHASES + 1) * taps);
      for (let p = 0; p <= PHASES; p++) {
        const frac = p / PHASES;
        let norm = 0;
        for (let k = 0; k < taps; k++) {
          // tap k sits at input index (floor(t) - half + 1 + k); distance from t:
          const d = k - this.half + 1 - frac;
          const x = 2 * fc * d;
          const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          const w = (d + this.half) / (2 * this.half); // 0..1 across the span
          const win = w <= 0 || w >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
          const v = 2 * fc * sinc * win;
          this.table[p * taps + k] = v;
          norm += v;
        }
        for (let k = 0; k < taps; k++) this.table[p * taps + k] /= norm; // unity DC gain
      }
    }
    this.hist = new Float32Array(2 * this.half);
    this.pos = this.half; // first output centred after a half-filter of zeros
  }

  /** Float samples in -1..1 at `inRate`; returns the 16 kHz int16 samples now complete. */
  process(input: Float32Array): Int16Array {
    if (!this.table) return toInt16(input);
    const taps = 2 * this.half;
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist);
    buf.set(input, this.hist.length);
    const out: number[] = [];
    // Output at position t needs buf[floor(t) - half + 1 .. floor(t) + half].
    while (Math.floor(this.pos) + this.half < buf.length) {
      const i = Math.floor(this.pos);
      const phase = Math.round((this.pos - i) * PHASES);
      const row = phase * taps;
      let acc = 0;
      const start = i - this.half + 1;
      for (let k = 0; k < taps; k++) acc += buf[start + k] * this.table[row + k];
      out.push(acc);
      this.pos += this.step;
    }
    // Keep what the next outputs still need.
    const keepFrom = Math.max(0, Math.floor(this.pos) - this.half + 1);
    this.hist = buf.slice(keepFrom);
    this.pos -= keepFrom;
    return toInt16(out);
  }
}

export function toInt16(samples: ArrayLike<number>): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}
