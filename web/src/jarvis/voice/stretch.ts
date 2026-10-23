/* Audio shaping for the assistant's spoken replies, done here rather than
   by the browser so it sounds the same in Chromium and the desktop's
   WebKit (whose pitch-preserving playbackRate is phasey at 1.5–2×).

   - trimSilence: TTS clips carry silence at both ends (Groq Orpheus: about
     half a second in front). Played back to back, that reads as separate
     clips stitched together; trimmed, the sentences flow.
   - timeStretch: WSOLA (waveform-similarity overlap-add) at a fixed rate.
     Each output frame is the input window, near its nominal position, that
     best continues the previous one, so speech speeds up without its pitch
     rising and without the doubled, echoing sound of plain overlap-add. */

/** Quieter than this counts as silence (about -50 dBFS). */
const SILENCE = 0.003;

/** The sample range [start, end) between the first and last sound, padded
    a little so consonants aren't clipped. The whole clip if it's all quiet. */
export function trimSilence(samples: Float32Array, sampleRate: number, padSeconds = 0.04): [number, number] {
  const step = Math.max(1, Math.round(sampleRate * 0.01));
  const loud = (from: number) => {
    let peak = 0;
    for (let i = from; i < Math.min(samples.length, from + step); i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak >= SILENCE;
  };
  let start = 0;
  while (start < samples.length && !loud(start)) start += step;
  if (start >= samples.length) return [0, samples.length];
  let end = samples.length;
  while (end > start && !loud(Math.max(start, end - step))) end -= step;
  const pad = Math.round(sampleRate * padSeconds);
  return [Math.max(0, start - pad), Math.min(samples.length, end + pad)];
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** `input` played `rate` times faster at the same pitch (rate 1: unchanged). */
export function timeStretch(source: Float32Array, rate: number, sampleRate: number): Float32Array {
  const win = Math.max(64, Math.round(sampleRate * 0.03));
  // Too short to stretch (a click-length fragment): play it as it is.
  if (!(rate > 0) || Math.abs(rate - 1) < 0.01 || source.length < win) return source;
  // Padded by a window so the last frames, and the sentence's final
  // consonant, aren't dropped.
  const input = new Float32Array(source.length + win);
  input.set(source);
  const hop = Math.round(win / 2);
  const search = Math.round(sampleRate * 0.008);
  const window = hann(win);
  const outLen = Math.ceil(input.length / rate) + win;
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  let outPos = 0;
  let prev = 0; // where the previous frame was taken from
  for (let k = 0; ; k++) {
    const nominal = Math.round(k * hop * rate);
    if (nominal + win >= input.length || outPos + win >= outLen) break;
    let best = nominal;
    if (k > 0) {
      // The natural continuation of the previous frame, one hop on: pick
      // the candidate near `nominal` that matches it best (coarse steps
      // keep this cheap enough for long answers).
      const ref = prev + hop;
      let bestScore = -Infinity;
      for (let d = -search; d <= search; d += 2) {
        const c = nominal + d;
        if (c < 0 || c + win >= input.length || ref + win >= input.length) continue;
        let score = 0;
        for (let i = 0; i < win; i += 4) score += input[c + i] * input[ref + i];
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    for (let i = 0; i < win; i++) {
      out[outPos + i] += input[best + i] * window[i];
      norm[outPos + i] += window[i];
    }
    prev = best;
    outPos += hop;
  }
  const len = Math.min(outLen, Math.ceil(source.length / rate));
  for (let i = 0; i < len; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.subarray(0, len);
}
