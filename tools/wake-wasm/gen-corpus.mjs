#!/usr/bin/env node
// Generates a TTS evaluation corpus for the wake word with macOS `say`:
// positives ("hey agora", "hey jarvis" for the fallback model) across the
// system's English voices and speaking rates, and negatives (ordinary speech,
// other assistants' phrases, near misses). 16 kHz mono 16-bit WAVs plus a
// manifest; the web test (web/src/jarvis/wake/corpus.eval.test.ts) embeds
// them in silence and noise and reports recall and false accepts.
//
//   node tools/wake-wasm/gen-corpus.mjs [outDir]   # default tools/wake-wasm/.cache/corpus
//
// macOS only (say + afconvert). The corpus is not committed: TTS voices
// differ between macOS releases, so it is regenerated, not versioned.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, ".cache", "corpus"));

// Natural-sounding English voices that ship with macOS. Novelty voices
// (Bells, Zarvox, Whisper, ...) are left out: nobody talks like that.
const VOICES = [
  "Samantha", "Daniel", "Karen", "Moira", "Tessa", "Rishi", "Aman", "Tara", "Kathy", "Fred",
  "Ralph", "Junior", "Albert",
  "Eddy (English (US))", "Eddy (English (UK))", "Flo (English (US))", "Flo (English (UK))",
  "Reed (English (US))", "Reed (English (UK))", "Rocko (English (US))", "Rocko (English (UK))",
  "Sandy (English (US))", "Sandy (English (UK))", "Shelley (English (US))", "Shelley (English (UK))",
  "Grandma (English (US))", "Grandpa (English (UK))",
];
const RATES = [150, 185, 220];

const POSITIVE = { hey_agora: ["hey agora", "hey, agora"], hey_jarvis: ["hey jarvis"] };
const NEGATIVE = [
  "agora",
  "hey siri",
  "hey claude",
  "hey cursor",
  "hey codex",
  "hey google",
  "alexa",
  "hey aurora",
  "hey laura",
  "a gorilla",
  "the agora in athens was a public square",
  "hey, are you going to the meeting later",
  "what time is it in new york right now",
  "can you summarize the last thread for me",
  "I think we should ship the release on friday",
  "hey there, how is it going",
  "let me grab a coffee and come back",
  "the build failed again because of the linter",
  "okay, open the design review channel",
  "angora sweaters are very soft",
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

async function synth(voice, rate, text, file) {
  const aiff = `${file}.aiff`;
  rmSync(aiff, { force: true });
  await run("say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, file]);
  rmSync(aiff);
}

async function pool(jobs, size) {
  let next = 0;
  const failed = [];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        // `say` occasionally fails under parallel load; retry before giving up.
        for (let attempt = 1; ; attempt++) {
          try {
            await job.run();
            break;
          } catch (err) {
            if (attempt < 4) continue;
            failed.push(`${job.name}: ${err.message.split("\n")[0]}`);
            break;
          }
        }
      }
    }),
  );
  return failed;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = [];
const jobs = [];
for (const voice of VOICES) {
  for (const rate of RATES) {
    for (const [model, texts] of Object.entries(POSITIVE)) {
      for (const text of texts) {
        const file = `pos_${model}_${slug(voice)}_${rate}_${slug(text)}.wav`;
        manifest.push({ file, text, voice, rate, label: "positive", model });
        jobs.push({ name: file, run: () => synth(voice, rate, text, join(out, file)) });
      }
    }
  }
  // Negatives at the middle rate only; they are many already.
  for (const text of NEGATIVE) {
    const file = `neg_${slug(voice)}_${slug(text)}.wav`;
    manifest.push({ file, text, voice, rate: 185, label: "negative" });
    jobs.push({ name: file, run: () => synth(voice, 185, text, join(out, file)) });
  }
}
const failed = await pool(jobs, Math.min(4, os.cpus().length));
const ok = manifest.filter((m) => !failed.some((f) => f.startsWith(m.file)));
writeFileSync(join(out, "manifest.json"), JSON.stringify(ok, null, 1));
console.log(`wrote ${ok.length} clips to ${out}${failed.length ? `; ${failed.length} failed:\n  ${failed.join("\n  ")}` : ""}`);
