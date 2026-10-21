#!/usr/bin/env node
// Builds the small committed test fixtures in web/src/jarvis/wake/__fixtures__
// from the TTS corpus (gen-corpus.mjs): a few clips embedded in a quiet,
// seeded noise floor, so the always-on test needs neither macOS nor the
// corpus. Run gen-corpus.mjs first, then host/check-features.sh to refresh
// the golden features.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, ".cache", "corpus");
const outDir = join(here, "..", "..", "web", "src", "jarvis", "wake", "__fixtures__");
mkdirSync(outDir, { recursive: true });

function readPcm(file) {
  const b = readFileSync(join(corpus, file));
  const at = b.indexOf("data");
  return new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + b.length));
}

let seed = 1234567;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;

function compose(parts) {
  const total = parts.reduce((n, p) => n + (typeof p === "number" ? p * 16 : p.length), 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    if (typeof p === "number") at += p * 16;
    else {
      out.set(p, at);
      at += p.length;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-32768, Math.min(32767, out[i] + Math.round(rand() * 40)));
  return out;
}

function writeWav(name, pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length * 2, 40);
  writeFileSync(join(outDir, name), Buffer.concat([h, Buffer.from(pcm.buffer)]));
  console.log(`${name}: ${(pcm.length / 16000).toFixed(2)} s`);
}

writeWav("hey_agora_samantha.wav", compose([1200, readPcm("pos_hey_agora_samantha_185_hey_agora.wav"), 1500]));
writeWav("hey_agora_daniel.wav", compose([1200, readPcm("pos_hey_agora_daniel_150_hey_agora.wav"), 1500]));
writeWav("hey_jarvis_karen.wav", compose([1200, readPcm("pos_hey_jarvis_karen_185_hey_jarvis.wav"), 1500]));
// Ordinary speech: no model should fire on it.
writeWav(
  "negatives.wav",
  compose([
    1200,
    readPcm("neg_samantha_what_time_is_it_in_new_york_right_now.wav"),
    800,
    readPcm("neg_daniel_can_you_summarize_the_last_thread_for_me.wav"),
    800,
    readPcm("neg_karen_i_think_we_should_ship_the_release_on_friday.wav"),
    800,
    readPcm("neg_samantha_the_build_failed_again_because_of_the_linter.wav"),
    800,
    readPcm("neg_daniel_okay_open_the_design_review_channel.wav"),
    800,
    readPcm("neg_samantha_alexa.wav"),
    1500,
  ]),
);
// Near misses the current Hey Agora model is known to accept (see
// docs/JARVIS_WAKE.md); gaps exceed the 2 s refractory period.
writeWav(
  "near_misses.wav",
  compose([
    1200,
    readPcm("neg_samantha_hey_claude.wav"),
    2500,
    readPcm("neg_daniel_agora.wav"),
    2500,
    readPcm("neg_karen_hey_google.wav"),
    1500,
  ]),
);
