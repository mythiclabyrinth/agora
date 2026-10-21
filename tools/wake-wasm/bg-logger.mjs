#!/usr/bin/env node
// Tiny loopback sink for the wake dev panel's ?wakeLog / VITE_WAKE_LOG
// beacons, for measuring what keeps running when the desktop window is
// unfocused, minimized or hidden (the webview's devtools are not reachable
// from a script). Prints one line per beacon with the receive time and
// appends the raw JSON to the given file.
//
//   node tools/wake-wasm/bg-logger.mjs [port=4529] [file=tools/wake-wasm/.cache/bg-log.jsonl]
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4529);
const file = process.argv[3] ?? join(here, ".cache", "bg-log.jsonl");
mkdirSync(dirname(file), { recursive: true });

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.writeHead(204).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const at = Date.now();
    appendFileSync(file, `${JSON.stringify({ at, ...safe(body) })}\n`);
    const j = safe(body);
    const time = new Date(at).toISOString().slice(11, 23);
    if (j.type === "tick") {
      console.log(
        `${time} tick audio=${Number(j.audioSec).toFixed(1)}s wall=${Number(j.wallSec).toFixed(1)}s ` +
          `score=${Number(j.score).toFixed(2)} active=${j.active} vis=${j.visibility} focus=${j.focus}`,
      );
    } else if (j.type === "wake") {
      console.log(`${time} WAKE ${j.phrase} score=${Number(j.score).toFixed(2)} vis=${j.visibility} focus=${j.focus}`);
    } else {
      console.log(`${time} ${j.type ?? "?"} ${body.slice(0, 160)}`);
    }
    res.writeHead(204).end();
  });
}).listen(port, "127.0.0.1", () => console.log(`wake bg-logger on http://127.0.0.1:${port}/log -> ${file}`));

function safe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
