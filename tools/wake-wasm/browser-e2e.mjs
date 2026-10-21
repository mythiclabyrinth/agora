#!/usr/bin/env node
// Real-browser check of the whole wake path: AudioWorklet capture + resample,
// MessagePort to the worker, wasm frontend + model, detection back on the
// main thread. Serves the built web/dist with `vite preview`, opens the dev
// panel in headless Chromium and WebKit (Playwright), and loops committed
// fixture WAVs into it, either as a MediaStream (?wakeFeed, both engines) or
// through Chromium's fake microphone (getUserMedia path).
//
//   npm run build && node tools/wake-wasm/browser-e2e.mjs [seconds=20]
//
// Prints detections, inference time per step and worker load per scenario,
// and exits non-zero if a positive clip was never heard or a negative was.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const web = join(root, "web");
const fixtures = join(web, "src", "jarvis", "wake", "__fixtures__");
const require = createRequire(join(web, "package.json"));
const { chromium, webkit } = require("playwright");

const seconds = Number(process.argv[2] ?? 20);
const port = Number(process.env.WAKE_E2E_PORT ?? (Number(process.env.AGORA_WEB_PORT ?? 5173) + 1));
const base = `http://127.0.0.1:${port}`;

const preview = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: web,
  stdio: ["ignore", "pipe", "ignore"], // the app's /api proxy errors (no server) are noise here
});
await new Promise((resolve, reject) => {
  preview.stdout.on("data", (b) => String(b).includes(String(port)) && resolve());
  preview.on("exit", (c) => reject(new Error(`vite preview exited ${c}`)));
  setTimeout(() => reject(new Error("vite preview did not start")), 20000);
});

const scenarios = [
  { engine: "chromium", source: "feed", clip: "hey_agora_samantha.wav", model: "hey_agora", expect: "hit" },
  { engine: "chromium", source: "mic", clip: "hey_agora_daniel.wav", model: "hey_agora", expect: "hit" },
  { engine: "chromium", source: "feed", clip: "negatives.wav", model: "hey_agora", expect: "none" },
  { engine: "webkit", source: "feed", clip: "hey_agora_samantha.wav", model: "hey_agora", expect: "hit" },
  { engine: "webkit", source: "feed", clip: "negatives.wav", model: "hey_agora", expect: "none" },
];

let failed = 0;
for (const s of scenarios) {
  const type = s.engine === "chromium" ? chromium : webkit;
  const args =
    s.engine === "chromium"
      ? [
          "--autoplay-policy=no-user-gesture-required",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-audio-capture=${join(fixtures, s.clip)}`,
        ]
      : [];
  const browser = await type.launch({ args });
  const context = await browser.newContext({ permissions: s.engine === "chromium" ? ["microphone"] : [] });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "warning" && String(m.text()).includes("wake") && errors.push(m.text()));
  await page.route("**/__wake_fixture/*", (route) =>
    route.fulfill({ body: readFileSync(join(fixtures, route.request().url().split("/").pop())), contentType: "audio/wav" }),
  );
  await page.route("**/__wake_log", (route) => {
    try {
      log.push(JSON.parse(route.request().postData() ?? "{}"));
    } catch {}
    return route.fulfill({ status: 204 });
  });
  const q = new URLSearchParams({ wakeDebug: "1", wakeAutostart: "1", wakeLog: `${base}/__wake_log` });
  if (s.source === "feed") q.set("wakeFeed", `/__wake_fixture/${s.clip}`);
  await page.goto(`${base}/?${q}`);
  await page.waitForSelector('[data-testid="wake-debug"]');
  await page.mouse.click(5, 5); // a gesture, for engines that hold audio until one
  await page.waitForTimeout(seconds * 1000);
  const hits = log.filter((l) => l.type === "wake");
  const stats = log.filter((l) => l.type === "stats");
  const ticks = log.filter((l) => l.type === "tick");
  const lastTick = ticks.at(-1) ?? {};
  const mean = (k) => (stats.length ? stats.reduce((n, x) => n + x[k], 0) / stats.length : NaN);
  const ok = s.expect === "hit" ? hits.length > 0 : hits.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${s.engine.padEnd(8)} ${s.source.padEnd(4)} ${s.clip.padEnd(24)} ` +
      `detections=${hits.length} audio=${(lastTick.audioSec ?? 0).toFixed(1)}s/wall=${(lastTick.wallSec ?? 0).toFixed(1)}s ` +
      `infer=${mean("meanMs").toFixed(3)}ms/step (max ${Math.max(0, ...stats.map((x) => x.maxMs)).toFixed(2)}) ` +
      `worker=${mean("workerBusyPct").toFixed(2)}% modelOn=${mean("activePct").toFixed(0)}%` +
      (errors.length ? `\n     errors: ${errors.slice(0, 3).join(" | ")}` : ""),
  );
  await browser.close();
}
preview.kill();
process.exit(failed ? 1 : 0);
