# Jarvis mode: the on-device wake word

On-device wake word detection for the web app and the Tauri desktop app's
WKWebView. Nothing leaves the machine until a detection fires; a detection
opens the assistant panel, which then holds a spoken conversation (see
[Voice conversation](#voice-conversation-the-panel)).

**Jarvis mode ships with "Hey Jarvis" for now** (the ESPHome model, at a
cutoff of 0.90; see the corpus numbers below). The Hey Agora model fires on
too many near-miss phrases to ship, so it stays in the `?wakeDebug=1` harness
until it is retrained. `JarvisWakeHost.tsx` (mounted by `AgoraLayout`) arms
the detector while the header chip's Jarvis mode is on and `/api/me` reports
`jarvis`, disarms it while a live voice session owns the mic, and reports the
mic state (`off | starting | listening | error`) in the chip's tooltip.

| Path | What it is |
| --- | --- |
| `web/src/jarvis/wake/JarvisWakeHost.tsx` | Jarvis mode's wake loop: arms Hey Jarvis while the mode is on, chime + `useJarvis.open()` on a detection, disarmed during live voice, mic errors on the chip |
| `web/src/jarvis/wake/detector.ts` | Main-thread API: `createWakeDetector({onWake, onScore, onStats, onError, model, cutoff, vad})` → `{start(stream \| {deviceId}), stop(), setCutoff(), holdOff(ms), setArmed(bool), running}` |
| `web/src/jarvis/wake/capture.worklet.ts` | AudioWorklet: downmix + resample to 16 kHz int16, posts 30 ms chunks straight to the worker over a `MessagePort` |
| `web/src/jarvis/wake/wake.worker.ts` | Worker: loads the wasm + model, runs frontend → energy gate → model → policy, posts score (10 Hz), detections, stats (5 s) |
| `web/src/jarvis/wake/engine.ts` | The detection policy, ported from `Esp32Agent/Wake.cpp` (pure TS, unit tested) |
| `web/src/jarvis/wake/runtime.ts` + `runtime/wake.wasm` | Typed wrapper over the committed wasm (TFLite Micro + TFLM microfrontend) |
| `web/src/jarvis/wake/vad.ts`, `resampler.ts`, `wav.ts` | Energy gate, windowed-sinc resampler, WAV reader |
| `web/src/jarvis/wake/wakeText.ts` | `stripWakePhrase` / `wakePhraseEnd`: port of `WakeText.h` (drops a leading "hey agora" from transcripts) |
| `web/src/jarvis/wake/DevWakePanel.tsx`, `debugFlag.ts` | Dev harness (lazy chunk, `?wakeDebug=1`) |
| `web/public/wake/` | Models + manifests, fetched by the worker on `start()` |
| `tools/wake-wasm/` | Pinned wasm build, feature cross-check, TTS corpus, browser E2E, background logger |

## Voice conversation (the panel)

Input is optional: the panel listens, answers aloud, and keeps listening.

- **Loop** (`web/src/jarvis/voice/conversation.ts`): wake (or opening the
  panel with the mic on) → chime → `listening` (already recording, so the
  first word isn't clipped; a window with no speech is dropped) → speech
  marks `recording` → ~1.4 s of quiet ends it, so a mid-sentence pause
  doesn't split a request (about 600 ms longer to submit than the old 0.8 s;
  a starting point measured on a paused test sentence, not yet tuned on real
  recordings) (`endpointer.ts`: RMS gate 0.015, clips with
  under 300 ms of voice are dropped, 30 s cap) → `transcribing` via
  `POST /api/jarvis/transcribe`, which hints the caller's visible channel,
  DM, and agent names to the recognizer (its `prompt`) → the normal
  `/api/jarvis/turn` → each
  finished sentence of the streamed answer (`sentences.ts`) is synthesized
  with `POST /api/jarvis/speech` and played in order (`speaking`, orb
  `shaping`, the beam follows the playback analyser, the sentence being
  spoken is highlighted) → an 8 s follow-up window (`listening`) → silence
  releases the mic and returns to `armed`, where the wake word takes over
  again. The first window after a wake or open is 10 s.
- **Speed, background, Stop**: replies play at the Features → Jarvis
  speaking speed (1×–2×, pitch kept; a change applies from the next
  sentence). Closing the panel stops listening and drops any recording or
  transcription in flight, but the answer keeps streaming and speaking, so
  it can be heard while reading; the wake word stays disarmed while it
  speaks, so the reply can't wake itself through the speakers. Reopening
  mid-answer neither chimes nor records over it. **Stop speaking** in the
  panel header silences the rest of the answer (text and cards keep
  arriving) without listening afterwards; it is one-off, not the Sound
  setting. Signing out, losing access, or switching Jarvis mode off stops
  everything (`JarvisVoiceHost`).
- **Barge-in**: 150 ms of speech while the answer plays stops the audio,
  drops the rest of the answer's speech, and records the interruption.
- **Mic**: opened with echo cancellation; the wake detector is disarmed
  while the conversation holds it (`micOwned`) and live voice always wins
  (the loop stands down when a live session starts).
- **Mic / speaker toggles** in the panel, persisted per device
  (`agora_jarvis_mic_muted`, `agora_jarvis_speaker_off`): muted means no
  conversational listening and no capture after a wake (typed input only);
  speaker off keeps replies text-only. Without STT / TTS (`/api/me`
  `jarvis_stt` / `jarvis_tts`) they show as unavailable with a hint.
- **Opening and hiding by voice**: "open #release" or "go to the deploy
  thread" navigates (the server checks the target is yours); "hide Jarvis"
  closes the panel once the answer is spoken and releases the mic, so the
  wake word re-arms. "Start a new conversation" does what New does once the
  answer is spoken. A card's Open buttons close the panel too. Jarvis mode
  itself stays on: only its switch turns it off.
- **Answering a draft in your own words**: every utterance goes to the
  server as a normal turn; the client never guesses intent. When the
  previous answer offered exactly one draft that is still live, the server's
  approval check (a separate call that sees only the reply and that draft)
  decides: an unconditional yes in any language ("yes go ahead", "haan bhej
  do", "sí, envíalo") posts it, a clear no cancels it, and anything
  conditional, hedged, or unrelated ("only if Priya agrees", "हाँ लेकिन पहले
  पूछो") ends the offer and goes to the assistant, which can draft again to
  re-offer it; the card's Send still works meanwhile. The loop applies the streamed
  `draft_sent` / `draft_cancelled` events to the card (Undo toast via the
  normal message delete) and speaks the short acknowledgement. Card edits
  are saved (debounced, on blur, and before Send or the next turn), so a
  yes is judged against the text the card shows.
- **Languages**: the assistant replies in the language you speak, and the
  sentence splitter handles scripts without spaces and their full stops
  (。！？；, danda, Arabic question mark, full-width forms) with highlight
  offsets intact across emoji. How well other languages are heard, judged
  and spoken depends on the configured STT, brain, and TTS providers.
- **Silence**: a recording with no speech returns `no_speech` from
  `/api/jarvis/transcribe`; the loop keeps listening without an error.
- **Server**: both endpoints are caller-authenticated and Jarvis-gated, not
  channel-scoped, and reuse `voice.rs` with the instance's configured
  provider, model and voice. "Jarvis-gated" means Jarvis's own switch and
  brain provider (Settings → Features → Jarvis: ChatGPT, OpenAI or
  Anthropic, each using the key or sign-in from Credentials), not Ask AI's;
  the voice loop itself always follows the Voice settings, whichever brain
  answers. Transcribe has the channel endpoint's 15 MB
  limit; speech takes at most 600 characters (one sentence at a time) and
  shares the message speech LRU cache. With `AGORA_JARVIS_MOCK=1` and no key,
  both fall back to mocks: transcripts from `AGORA_JARVIS_MOCK_TRANSCRIPT`
  (`|`-separated phrases are returned in turn) and a soft tone for speech.

## Runtime choice: TFLite Micro compiled to WebAssembly

The models are microWakeWord v2 `stream_state_internal_quant` flatbuffers:
int8 `[1, 3, 40]` in, uint8 `[1, 1]` out, with their streaming state in
resource variables (`CALL_ONCE` + `VAR_HANDLE` / `READ_VARIABLE` /
`ASSIGN_VARIABLE`). Options considered:

- **(a) TFLM + microfrontend → one wasm (chosen).** The exact C/C++ the ESP32
  desk runs, so features and inference match the firmware by construction,
  the resource-variable ops are the ones ESPHome uses, and the result is
  small: **179 KB wasm (64 KB gzipped)**, no JS glue, imports limited to three
  WASI stubs. Built with emscripten in Docker; the `.wasm` is committed so
  nobody needs emscripten to work on the web app.
- (b) LiteRT.js / `@tensorflow/tfjs-tflite`: the full TFLite runtime does
  have the resource-variable ops, but it is a multi-MB wasm (plus XNNPACK
  and threads/SIMD variants), tfjs-tflite is deprecated, and we would still
  need a feature frontend. Not spiked further: (a) worked first time.
- (c) Port the microfrontend to TS + a JS interpreter: the most new code and
  the most ways to drift from what the models were trained on.

Almost none of it weighs on the main bundle: `JarvisWakeHost` imports the
small `detector.ts` (a few KB), but the worklet, worker, wasm and model are
separate assets fetched only on `start()`, i.e. only once Jarvis mode is on.
`npm run build` emits `capture.worklet-*.js` 2 KB, `wake.worker-*.js` 8 KB,
`wake-*.wasm` 179 KB and the lazy `DevWakePanel-*.js` 6 KB.

### Firmware semantics, ported faithfully

From `Esp32Agent/Wake.cpp` / `Board.h`, in `engine.ts` + `wake_api.cc`:

- Frontend config: 30 ms window, 10 ms step, 40 channels, 125–7500 Hz,
  noise reduction (smoothing bits 10, even 0.025, odd 0.06, min signal 0.05),
  PCAN (strength 0.95, offset 80, gain bits 21), log scale (shift 6).
- Quantization `q = (v * 256 + 333) / 666 - 128`, clamped to int8 (in C).
- Stride: the model's input dim 1 (3 frames, so one inference per 30 ms).
- Sliding window of the manifest's size (5); fires when the window *sum*
  exceeds `round(cutoff * 255) * window` (strict), cutoff clamped 0.50–0.99.
- Warm-up 1000 ms after (re-)arming, refractory 2000 ms after a detection,
  `holdOff(ms)` only ever extends, peak held 3000 ms, multi-model
  arbitration 150 ms with the highest window mean winning (`wakeArbitrate`).
- The frontend runs on every 10 ms block even while deaf, so its noise
  estimate tracks the room; only the models wait.
- The engine counts time in samples, never wall clock, so files and the live
  mic go through identical logic.

Added for the browser: an **energy gate** (`vad.ts`, adaptive noise floor,
opens 9 dB above it and above -62 dBFS, 1 s hangover). While it is shut the
model does not run; features go into a 1 s pre-roll ring that is replayed
through the model when the gate opens, so a phrase's first syllable is never
lost to gate latency. Results match always-on inference to within 100 ms on
every fixture (not bit-identical: frames older than the pre-roll never reach
the streaming state).

## Verification

All numbers from an Apple M5, Node 22, Chromium/WebKit from Playwright 1.61.

### Features vs the firmware frontend

`tools/wake-wasm/host/check-features.sh` compiles the ESP32 desk's
**vendored** `src/microfrontend` with `features_dump.cc` (configured
verbatim as `Wake.cpp`) and writes `__fixtures__/golden-features.json`;
`pipeline.test.ts` asserts wake.wasm reproduces it **bit for bit** on all 5
fixtures, under arbitrary chunking. The vendored sources are byte-identical
to TFLM `b57ba0d` apart from include paths and the kissfft namespace alias
(checked with `diff`).

One caveat, measured rather than assumed: the frontend's *runtime* is pure
integer, but its init tables are computed once with libm floats. Compiled
natively on macOS/arm64, one mel filterbank weight differs by 1 LSB
(2470/1626 vs 2471/1625), which moves 0–2 feature values per clip by ≤5 units
(out of 14–71 k). The ESP32's newlib is a third libm, so the board may match
either build in that one entry; the effect on scores is far below the
cutoff's resolution.

### Detection (committed fixtures, runs in `npm test`)

TTS clips (macOS `say`) in a seeded -64 dBFS noise floor:
`hey_agora_{samantha,daniel}.wav` are each heard exactly once with the
crossing inside the phrase; `negatives.wav` (17.8 s of ordinary speech) is
silent for both models; resampling from 48 kHz and 44.1 kHz still detects;
Hey Jarvis (ESPHome reference model) detects its phrase and ignores Hey
Agora and the near misses.

### Corpus evaluation (TTS, local only)

`node tools/wake-wasm/gen-corpus.mjs` (783 clips: 27 English macOS voices ×
3 rates; positives "hey agora" / "hey, agora" / "hey jarvis"; 20 negative
phrases per voice), then `WAKE_EVAL=1 npm test -w web -- corpus`. Each clip
gets 1.2 s lead-in and 1.5 s tail, under *quiet* (-64 dBFS floor), *noisy*
(white noise ~-36 dBFS) and *far* (speech -12 dB).

| Model @ its cutoff | Quiet recall | Noisy | Far | False accepts / 621–702 clips | Continuous speech (19–21 min, back to back) |
| --- | --- | --- | --- | --- | --- |
| **Hey Agora** @ 0.95 | 157/162 (96.9%) | 141/162 (87.0%) | 144/162 (88.9%) | **205 / 147 / 171** | **34 false accepts ≈ 108/h** |
| Hey Jarvis @ 0.97 (manifest) | 57/81 (70.4%) | 51/81 (63.0%) | 56/81 (69.1%) | 0 / 0 / 0 | 0 |
| **Hey Jarvis @ 0.90 (shipped)** | 65/81 (80.2%) | 56/81 (69.1%) | 65/81 (80.2%) | 0 / 1 / 0 | **0 in 20.9 min** |

Cutoff sweep (quiet), from each clip's highest window sum:

| cutoff | 0.50 | 0.80 | 0.90 | 0.95 | 0.97 | 0.99 |
| --- | --- | --- | --- | --- | --- | --- |
| Hey Agora recall / FA rate | 1.00 / 0.52 | 1.00 / 0.42 | 1.00 / 0.36 | 0.98 / 0.33 | 0.96 / 0.30 | 0.90 / 0.27 |
| Hey Jarvis recall / FA rate | 0.89 / 0.01 | 0.82 / 0 | 0.82 / 0 | 0.79 / 0 | 0.70 / 0 | 0.67 / 0 |

**Hey Jarvis cutoff: 0.90.** Measured 2026-10-21 (same corpus, 702 negative
clips incl. the near misses, 81 positives): recall rises 10 points quiet/far
and 6 points noisy over the manifest's 0.97, the 20.9-minute continuous
speech run stays at 0 false accepts, and the only clip false accept is one
"hey claude" (1/27 voices) under white noise. Detections land a mean 87 ms
before the phrase ends (76 ms at 0.97). 0.80 gains no recall on this corpus,
so 0.90 keeps the margin. The cutoff lives in `WAKE_MODELS` (`detector.ts`)
and `testkit.ts`; the upstream `hey_jarvis.json` manifest still says 0.97.

**Finding: the current Hey Agora model is not specific enough to ship.** It
fires on "hey" + almost any two-syllable word and on "agora" alone, with
saturated (255) probabilities, so no cutoff separates them. Per-phrase false
accepts (quiet, of 27 voices): "hey claude" 27, "hey google" 27, "hey aurora"
26, "hey laura" 25, "agora" 19, "hey jarvis" 17, "hey cursor" 15, "hey there,
how is it going" 12, "the agora in athens…" 11, "hey codex" 9, "hey siri" 6.
The pipeline is not the cause: the same pipeline gives the ESPHome Hey Jarvis
model zero false accepts on the same 702 clips, and it reproduces the
firmware's features exactly. The model's own calibration (0.21 FA/h) was
measured on *ambient* audio, which has none of these near misses. The test
`Hey Agora stays quiet on near misses` is marked `it.fails` so a retrained
model flips it.

Fix: retrain with these phrases (and the other agents' wake phrases) in the
negative set, as `Esp32Agent/tools/wake/README.md` step 3 describes, then
drop the new `.tflite` + manifest into `web/public/wake/`. Interim options for
Phase 1: verify a detection with the transcript (keep ~2 s of audio before
the crossing, transcribe, require `wakePhraseEnd() > 0`), or offer Hey Jarvis
(chosen: Jarvis mode uses Hey Jarvis until Hey Agora is retrained).

Caveats: TTS is not people. Recall on real voices, accents and real rooms is
unmeasured; the Hey Jarvis recall gap on some TTS voices (Daniel, Rishi,
Albert) is likely a TTS artifact.

### Real browsers (`tools/wake-wasm/browser-e2e.mjs`)

`VITE_WAKE_DEBUG=1 npm run build && node tools/wake-wasm/browser-e2e.mjs 20` serves `web/dist`
with `vite preview`, opens the dev panel headless, and loops a fixture into
the real AudioWorklet → worker → wasm path for 20 s:

| Engine | Source | Clip | Detections | Audio / wall | ms per step (max) | Worker load | Model on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium | MediaStream | hey_agora_samantha | 5 | 19.2 / 19.9 s | 0.110 (4.4) | 0.49% | 34% |
| Chromium | fake mic (getUserMedia) | hey_agora_daniel | 6 | 18.8 / 18.9 s | 0.082 (2.0) | 0.44% | 31% |
| Chromium | MediaStream | negatives | 0 | 19.8 / 19.9 s | 0.100 (3.4) | 0.64% | 92% |
| WebKit | MediaStream | hey_agora_samantha | 5 | 18.9 / 19.0 s | 0.179 (1.0) | 0.80% | 33% |
| WebKit | MediaStream | negatives | 0 | 19.8 / 20.0 s | 0.028 (2.0) | 0.11% | 85% |

### Jarvis mode end to end (Chromium, 2026-10-21)

`npm run build`, `agora-server` with `AGORA_JARVIS_MOCK=1` (the mock brain also
makes `/api/me` report `jarvis: true`), and Playwright Chromium with
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<wav>` looping `hey_jarvis_karen.wav` with
4 s gaps:

| Check | Result |
| --- | --- |
| Mode off | no `getUserMedia` call |
| Chip on | "Listening for “Hey Jarvis”" within ~1 s; the panel opens on the first phrase (~6 s); a typed mock turn still answers, and further wakes while open leave it alone |
| Chip off | the mic track is stopped (`readyState` ended), no wakes and no new `getUserMedia` for 22 s |
| Reload with the mode persisted | resumes listening with no gesture (Chromium lets an AudioContext run while the page captures the mic, even under `--autoplay-policy=user-gesture-required`) and wakes again |
| Mic denied (new headless + CDP permission denied) | chip `is-error`, tooltip "Microphone access is off…"; ⌘J and typed turns still work |
| Live voice running | no wake in 25 s; wakes again ~1 s after ending it |
| `negatives.wav`, `near_misses.wav` looped 45 s | no wake |

The voice loop, with an injected mic (a `MediaStreamAudioDestinationNode`
the test speaks TTS clips into) against the mock brain with scripted mock
STT / TTS (no provider keys, so **real STT/TTS were not exercised**): wake →
listening → "what agents are online" → recording → transcribing → turn →
answer spoken (1 speech request, 1 playback, sentence highlighted) →
follow-up listening; a follow-up draft request is read back ("Drafted it for
#general: …. Send it?") and a spoken "send it" posts it (at the time this
ran, a client-side phrase match; replies are now judged by the server's
approval check); 8.6 s of silence → `armed` with the conversation's mic track stopped
and the wake word re-armed; talking over an answer pauses it and records;
muted → no capture, even after a wake; speaker off → no speech requests or
playback. 16/16 checks, no page errors.

Old headless Chromium without the fake UI rejects `getUserMedia` with
`NotSupportedError`, not `NotAllowedError`, so use the new headless
(`channel: "chromium"`) to exercise a denial. Where an engine holds the
AudioContext until a gesture (WebKit), the chip shows "Audio is paused until
you click or press a key in the window." and flips back to listening on the
next click or key (emulated in Chromium).

### Cost

- Inference: **0.03–0.18 ms per step** (one step per 30 ms of audio), i.e.
  0.1–0.6% of one core for the model; in Node the whole pipeline runs at
  0.0016× real time (1 h of audio in ~6 s).
- Worker load (frontend + gate + model + messaging) **0.1–0.8%** of wall time.
- In silence the gate keeps the model off: 10 s of near-silence runs < 40
  steps (the startup pre-roll) instead of 333; the frontend keeps running.
- Memory: arena 20.6 KB (Hey Agora) / 15.5 KB (Hey Jarvis) used; wasm heap
  starts at 2 MB.
- WebKit coarsens `performance.now()` to 1 ms, so its max/mean are
  quantized.

## Trying it

```bash
source .worktree-env && npm run dev -w web -- --port "$AGORA_WEB_PORT"
# open http://127.0.0.1:$AGORA_WEB_PORT/?wakeDebug=1 (sticks; ?wakeDebug=0 clears)
```

The query flag only works on the dev server: production builds mount the
harness only when built with `VITE_WAKE_DEBUG=1`, because it can open the
mic outside Jarvis mode.

The panel (bottom right) has Start mic, model choice (Hey Agora / Hey
Jarvis), the cutoff slider, live score and 3 s peak bars with the cutoff
line, input level, gate state, timing stats, a green flash and a log line per
detection, "hold off 3 s", and a "feed WAV" picker that loops a file through
the real worklet path instead of the mic. Query flags: `wakeAutostart=1`,
`wakeFeed=<wav url>`, `wakeLog=<url>` (beacons for
`tools/wake-wasm/bg-logger.mjs`). For shells whose URL you cannot edit, the
same as build-time env: `VITE_WAKE_DEBUG`, `VITE_WAKE_AUTOSTART`,
`VITE_WAKE_FEED`, `VITE_WAKE_LOG`, plus `VITE_WAKE_BGTEST=1` (scripted
minimize/hide in the desktop app).

## Desktop (Tauri v2 / WKWebView)

- **Mic access**: `getUserMedia` works in the webview because
  `crates/agora-desktop/Info.plist` carries `NSMicrophoneUsageDescription`
  (without it macOS kills the app on the first request) and
  `Entitlements.plist` grants `device.audio-input` / `device.microphone` to
  the signed app. macOS shows its own TCC prompt once per app.
- **Secure origin**: `navigator.mediaDevices` only exists in secure
  contexts. Embedded mode loads `http://127.0.0.1:<port>` (loopback counts
  as secure), remote mode an `https://` server; a plain-`http://` LAN server
  gets no mic. `start()` says so instead of failing obscurely.
- **AudioContext**: WebKit may keep a context suspended without a user
  gesture; `start()` waits 500 ms, then reports "Audio is paused until you
  click or press a key" and resumes on the next pointer/key event.

### Background behaviour (measured 2026-10-21, macOS 26, dev build)

Run with an isolated identifier so the real app's data is untouched:
`npx @tauri-apps/cli@2 dev --config '{"identifier":"app.agora.desktop.wakedev", ...}'`
(the inline capability adds `core:window:allow-minimize/unminimize/hide/show/set-focus`
for the loopback origin), a dist built with `VITE_WAKE_*` flags, and
`bg-logger.mjs` receiving beacons. **The Mac's screen was locked for the whole
session** (`CGSSessionScreenIsLocked`), so the page reported
`visibilityState = hidden`, `hasFocus() = false` throughout, and no state with
a visible window could be produced.

| State | Source | Result |
| --- | --- | --- |
| (a) focused | — | **Not verified** (screen locked) |
| (b) unfocused but visible | — | **Not verified** (screen locked; no Apple Events permission to drive other apps) |
| locked screen, window visible-but-occluded | WAV looped via MediaStream | Kept running: 53 detections in 197 s, one per 3.7 s loop, audio clock = wall clock (197.1 / 197.2 s), 0.105 ms/step, worker 0.58% |
| (c) minimized (via Tauri `minimize()`) | same | Kept running: detections every 3.7 s for the whole 25 s |
| (d) hidden / closed-to-tray (`hide()`, what the close button does) | same | Kept running: detections every 3.7 s for the whole 25 s; restore timer fired on time |
| any of the above | **live mic** | **Not verified**: `getUserMedia` never resolved in 2+ minutes with the screen locked (WebKit defers capture for a hidden page, or the TCC prompt could not be answered), and ~8 s after load the page stopped running timers at all. |

**Jarvis mode in the desktop dev build (2026-10-21)**, isolated identifier
`app.agora.desktop.jarvisdev`, mock brain: the chip and panel work, but the
mic never opened. Unbundled `tauri dev` gets an immediate `NotAllowedError`
(TCC judges the launching terminal process and does not prompt), which the
chip ("Microphone access is off…") and the panel status show as intended.
An ad-hoc bundled copy with `NSMicrophoneUsageDescription` left
`getUserMedia` pending (chip: "Waiting for the microphone…") for 100+ s: the
macOS prompt was never answered, and the screen locked during the run. A
wake through the speakers (`afplay`) and the voice loop on desktop are
therefore **unverified**; test with a signed build on an unlocked Mac.

Main-thread `setInterval(1 s)` was throttled to ~2 s while hidden, but audio,
the worklet, the worker and `postMessage` were not. Important caveat: in
the WAV runs the page was *playing audio* (an `AudioBufferSourceNode`), which
is exactly what WebKit exempts from background suspension; the mic run with
nothing playing was suspended. Whether an *active* mic capture alone keeps a
hidden WKWebView alive is therefore still open: repeat on an unlocked Mac by
running `bg-logger.mjs`, the desktop dev build with
`VITE_WAKE_DEBUG=1 VITE_WAKE_AUTOSTART=1 VITE_WAKE_BGTEST=1 VITE_WAKE_LOG=…`,
and `afplay web/src/jarvis/wake/__fixtures__/hey_agora_samantha.wav` in a
loop near the mic. If it suspends, native detection in Rust (cpal + the same
TFLM C code) is the later phase.

## Provenance and licences

**Models** (`web/public/wake/`), copied from
`Esp32Agent/tools/wake/models/` at Esp32Agent commit `4473f9f`:

| File | SHA-256 | Origin |
| --- | --- | --- |
| `hey_agora.tflite` (60 920 B) | `14a1ffc0…388e6bc` | Trained by Tom Jose with [microWakeWord-Trainer-AppleSilicon](https://github.com/TaterTotterson/microWakeWord-Trainer-AppleSilicon) (microWakeWord v2, int8, stride 3); calibration generated 2026-09-26, committed to Esp32Agent 2026-09-30 (`1a92238`, "a smaller Hey Agora model"). Trainer calibration: recall 0.952 at 0.207 FA/h (target 0.25) on 50 000 validation positives and 9.67 h ambient. Agora's own model. |
| `hey_agora.json` | `f102fbb7…e6dc6` | Its manifest (cutoff 0.95, window 5, arena 30 000). |
| `hey_jarvis.tflite` (52 272 B) | `21a7976a…4b78b77` | Pre-trained by Kevin Ahrendt, [esphome/micro-wake-word-models](https://github.com/esphome/micro-wake-word-models) `models/v2/`, commit `05b6592`, **Apache-2.0**. Jarvis mode's wake word for now. |
| `hey_jarvis.json` | `b153867d…20185af` | Its manifest (cutoff 0.97, window 5, arena 22 860); Agora overrides the cutoff to 0.90. |

**Code compiled into `runtime/wake.wasm`** (licence texts in
`web/src/jarvis/wake/runtime/LICENSES/`):

| Component | Version | Licence |
| --- | --- | --- |
| TensorFlow Lite Micro + `experimental/microfrontend` | `b57ba0d0d40d66cc775fa06fbffcec9e0c50b2c8` | Apache-2.0 |
| FlatBuffers (headers) | v25.9.23 (TFLM pin) | Apache-2.0 |
| gemmlowp (fixed-point headers) | `719139ce` (TFLM pin) | Apache-2.0 |
| ruy (headers, TFLM pin) | `d3712831` | Apache-2.0 |
| kissfft (FIXED_POINT=16) | v130 (TFLM pin) | BSD-3-Clause |
| `tools/wake-wasm/src/wake_api.cc` | this repo | this repo's licence |

### Rebuilding the wasm

```bash
tools/wake-wasm/build.sh          # rebuild + overwrite runtime/wake.wasm and LICENSES/
tools/wake-wasm/build.sh --check  # rebuild to .cache and compare bytes with the committed file
tools/wake-wasm/host/check-features.sh   # refresh golden features from the ESP32 vendored frontend
node tools/wake-wasm/make-fixtures.mjs   # rebuild the committed fixtures from the TTS corpus
```

Pins: TFLM commit above; emscripten **4.0.15** in Docker by digest
(`emscripten/emsdk@sha256:d4216eed…` arm64, `@sha256:27bc6267…` amd64, both
in `build.sh`); third-party deps fetched by TFLM's own
`create_tflm_tree.py` at its pinned URLs; sources compiled in sorted order
with `-ffile-prefix-map`. A from-scratch rebuild on arm64 reproduced the
committed file byte for byte (sha256
`f3383530bcea792b2b01753e798e38102da5e79c76e253552998d6f4ff4b07ab`). The
amd64 image should produce the same bytes (same emscripten/LLVM) but that
was not run.

## Known gaps

- The Hey Agora model's false accepts (above): why Jarvis mode uses Hey
  Jarvis for now.
- Real-voice recall and real-room false-accept rates are unmeasured (TTS only).
- Desktop background with a live mic, and the focused / unfocused-visible
  states, are unverified (locked screen during the run).
- The panel's voice loop has only run against the mock STT / TTS; real
  providers, real rooms and real echo (speakers into the mic) are untested.
- With two or more drafts offered at once, a bare "yes" approves neither
  (it can't say which); the card's Send still works.
- No echo cancellation in the loop beyond the browser's own
  `echoCancellation`: callers must `holdOff()` while Agora speaks, as the
  firmware does around its own sounds.
- One model at a time from the panel; the engine and wasm support up to 4
  (with arbitration) for later per-agent phrases.
