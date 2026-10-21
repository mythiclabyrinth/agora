/* Recall / false-accept evaluation over the TTS corpus from
   tools/wake-wasm/gen-corpus.mjs (macOS `say`, not committed). Skipped when
   the corpus is absent or WAKE_EVAL is unset, so CI, Linux and everyday
   `npm test` stay fast; run it locally (about a minute) with

     node tools/wake-wasm/gen-corpus.mjs
     WAKE_EVAL=1 npm test -w web -- corpus

   Each positive is embedded in 1.2 s of lead-in (past the engine's 1 s
   warm-up) and 1.5 s of tail, under three conditions; negatives the same,
   plus one continuous stream of every negative back to back for a
   false-accepts-per-hour figure. Prints a table and writes
   tools/wake-wasm/.cache/eval-report.json. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { maxWindowSum, readPcm16, runClip, type ModelId } from "./testkit";

const CACHE = fileURLToPath(new URL("../../../../tools/wake-wasm/.cache/", import.meta.url));
const CORPUS = `${CACHE}corpus/`;
const have = existsSync(`${CORPUS}manifest.json`) && Boolean(process.env.WAKE_EVAL);

interface Clip {
  file: string;
  text: string;
  voice: string;
  rate: number;
  label: "positive" | "negative";
  model?: ModelId;
}

// Deterministic noise so the numbers are reproducible run to run.
function noise(n: number, amp: number, seed: number): Int16Array {
  let s = seed >>> 0 || 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = Math.round(((s / 2 ** 32) * 2 - 1) * amp);
  }
  return out;
}

const CONDITIONS = {
  // -64 dBFS floor: a quiet room through a laptop mic.
  quiet: { gain: 1, noiseAmp: 40 },
  // White noise around -36 dBFS: a fan or a busy office, ~15-20 dB SNR.
  noisy: { gain: 1, noiseAmp: 1000 },
  // The speaker farther away: speech 12 dB lower over the quiet floor.
  far: { gain: 0.25, noiseAmp: 40 },
} as const;
type Condition = keyof typeof CONDITIONS;

function embed(speech: Int16Array, cond: Condition, seed: number, leadMs = 1200, tailMs = 1500): Int16Array {
  const { gain, noiseAmp } = CONDITIONS[cond];
  const lead = (leadMs * 16) | 0;
  const out = noise(lead + speech.length + ((tailMs * 16) | 0), noiseAmp, seed);
  for (let i = 0; i < speech.length; i++) {
    const v = out[lead + i] + speech[i] * gain;
    out[lead + i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

describe.skipIf(!have)("wake corpus evaluation (TTS)", () => {
  const clips: Clip[] = have ? JSON.parse(readFileSync(`${CORPUS}manifest.json`, "utf8")) : [];
  const report: Record<string, unknown> = {};

  it.each(["hey_agora", "hey_jarvis"] as const)("%s: recall and false accepts", async (model) => {
    const positives = clips.filter((c) => c.label === "positive" && c.model === model);
    const others = clips.filter((c) => c.label === "positive" && c.model !== model);
    const negatives = clips.filter((c) => c.label === "negative");
    const rows: Record<string, unknown>[] = [];
    let inferMs = 0;
    let steps = 0;
    let wallMs = 0;
    let audioMs = 0;
    let latencySum = 0;
    let latencyN = 0;

    for (const cond of Object.keys(CONDITIONS) as Condition[]) {
      let hits = 0;
      const missed: string[] = [];
      for (const [i, c] of positives.entries()) {
        const speech = readPcm16(`${CORPUS}${c.file}`);
        const r = await runClip(embed(speech, cond, i + 1), model);
        inferMs += r.inferenceMs;
        steps += r.modelSteps;
        wallMs += r.totalMs;
        audioMs += r.audioMs;
        if (r.detections.length) {
          hits++;
          // Detection time relative to the end of the spoken phrase.
          latencySum += r.detections[0].samplePos / 16 - (1200 + speech.length / 16);
          latencyN++;
        } else missed.push(`${c.voice}@${c.rate} "${c.text}"`);
      }
      let fa = 0;
      const faByText: Record<string, number> = {};
      for (const [i, c] of [...negatives, ...others].entries()) {
        const r = await runClip(embed(readPcm16(`${CORPUS}${c.file}`), cond, 1000 + i), model);
        if (r.detections.length) {
          fa++;
          faByText[c.text] = (faByText[c.text] ?? 0) + 1;
        }
      }
      const faList = Object.entries(faByText)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `"${t}" x${n}`);
      rows.push({
        condition: cond,
        recall: `${hits}/${positives.length} (${((100 * hits) / positives.length).toFixed(1)}%)`,
        falseAccepts: `${fa}/${negatives.length + others.length}`,
        missed: missed.slice(0, 8).join("; ") + (missed.length > 8 ? ` (+${missed.length - 8})` : ""),
        falseAcceptsOn: faList.join("; "),
      });
    }

    // Cutoff sweep (quiet condition) from each clip's highest window sum.
    const posMax = await Promise.all(positives.map((c, i) => maxWindowSum(embed(readPcm16(`${CORPUS}${c.file}`), "quiet", i + 1), model)));
    const negMax = await Promise.all(
      [...negatives, ...others].map((c, i) => maxWindowSum(embed(readPcm16(`${CORPUS}${c.file}`), "quiet", 1000 + i), model)),
    );
    const window = 5;
    const sweep = [0.5, 0.8, 0.9, 0.95, 0.97, 0.99, 0.999].map((cut) => {
      const line = Math.round(cut * 255) * window;
      return {
        cutoff: cut,
        recall: +(posMax.filter((m) => m > line).length / posMax.length).toFixed(3),
        falseAcceptRate: +(negMax.filter((m) => m > line).length / negMax.length).toFixed(3),
      };
    });
    console.table(sweep);

    // Continuous stream: every negative (and the other model's positives)
    // back to back with 300 ms gaps, through one engine, as a long session.
    const parts = [...negatives, ...others].map((c) => readPcm16(`${CORPUS}${c.file}`));
    const gap = 300 * 16;
    const total = 1200 * 16 + parts.reduce((n, p) => n + p.length + gap, 0);
    const stream = noise(total, 40, 99);
    let at = 1200 * 16;
    for (const p of parts) {
      for (let i = 0; i < p.length; i++) stream[at + i] = Math.max(-32768, Math.min(32767, stream[at + i] + p[i]));
      at += p.length + gap;
    }
    const long = await runClip(stream, model);
    const hours = total / 16000 / 3600;

    const summary = {
      model,
      positives: positives.length,
      negatives: negatives.length + others.length,
      voices: new Set(clips.map((c) => c.voice)).size,
      meanDetectionAfterPhraseEndMs: latencyN ? Math.round(latencySum / latencyN) : null,
      inferenceMsPerStep: +(inferMs / Math.max(1, steps)).toFixed(4),
      pipelineRealtimeFactor: +(wallMs / audioMs).toFixed(5),
      continuousSpeech: {
        minutes: +((total / 16000) / 60).toFixed(1),
        falseAccepts: long.detections.length,
        perHourOfSpeech: +(long.detections.length / hours).toFixed(1),
        modelDutyCycle: +(long.modelSteps / (total / 480)).toFixed(3),
      },
    };
    report[model] = { summary, rows, sweep };
    console.log(`\n=== ${model} ===`);
    console.table(rows.map(({ condition, recall, falseAccepts }) => ({ condition, recall, falseAccepts })));
    for (const r of rows) {
      if (r.missed) console.log(`[${r.condition}] missed: ${r.missed}`);
      if (r.falseAcceptsOn) console.log(`[${r.condition}] false accepts: ${r.falseAcceptsOn}`);
    }
    console.log(JSON.stringify(summary, null, 1));
    writeFileSync(`${CACHE}eval-report.json`, JSON.stringify(report, null, 1));

    // Regression floor, not a target: the trainer's own validation recall is
    // 95% at 0.21 FA/h; TTS through clean audio should stay well above this.
    const quiet = rows[0].recall as string;
    expect(Number(quiet.split("/")[0]) / positives.length).toBeGreaterThan(0.6);
  }, 600_000);
});
