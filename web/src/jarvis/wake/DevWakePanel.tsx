/* Dev harness for the wake word: live score / peak / cutoff, a flash on each
   detection, and the worker's timing stats. Not part of the product UI;
   main.tsx lazy-loads it only when wakeDebugEnabled() (debugFlag.ts). Optional:
     ?wakeAutostart=1 / VITE_WAKE_AUTOSTART=1  start listening on load
     ?wakeLog=<url>   / VITE_WAKE_LOG=<url>    POST a JSON line per second and
                                               per detection (tools/wake-wasm/bg-logger.mjs)
     ?wakeFeed=<wav url> / VITE_WAKE_FEED      loop a WAV through the real worklet +
                                               worker path instead of the mic (also:
                                               the "feed WAV" file picker) */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createWakeDetector, WAKE_MODELS, type WakeDetection, type WakeDetector, type WakeScore, type WakeStats } from "./detector";

const params = new URLSearchParams(location.search);
const env = import.meta.env;

const logUrl = params.get("wakeLog") || (env.VITE_WAKE_LOG as string | undefined) || "";
const autostart = params.get("wakeAutostart") === "1" || env.VITE_WAKE_AUTOSTART === "1";
const feedUrl = params.get("wakeFeed") || (env.VITE_WAKE_FEED as string | undefined) || "";

/** Loops decoded audio into a MediaStream, standing in for a mic. */
async function wavStream(bytes: ArrayBuffer): Promise<{ stream: MediaStream; close: () => void }> {
  const ac = new AudioContext();
  const buffer = await ac.decodeAudioData(bytes);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const dst = ac.createMediaStreamDestination();
  src.connect(dst);
  src.start();
  if (ac.state === "suspended") await ac.resume();
  return { stream: dst.stream, close: () => void ac.close() };
}

function beacon(payload: Record<string, unknown>) {
  if (!logUrl) return;
  // text/plain keeps it a simple request: no CORS preflight to the logger.
  void fetch(logUrl, { method: "POST", body: JSON.stringify(payload), mode: "no-cors", keepalive: true }).catch(() => {});
}

type ModelKey = keyof typeof WAKE_MODELS;

export default function DevWakePanel() {
  const [modelKey, setModelKey] = useState<ModelKey>("hey_agora");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [score, setScore] = useState<WakeScore | null>(null);
  const [stats, setStats] = useState<WakeStats | null>(null);
  const [cutoff, setCutoff] = useState<number>(WAKE_MODELS.hey_agora.cutoff);
  const [armed, setArmed] = useState(true);
  const [hits, setHits] = useState<{ at: string; d: WakeDetection }[]>([]);
  const [flash, setFlash] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const det = useRef<WakeDetector | null>(null);
  const last = useRef<WakeScore | null>(null);
  const started = useRef(0);
  const feed = useRef<{ close: () => void } | null>(null);

  const stop = () => {
    det.current?.stop();
    det.current = null;
    feed.current?.close();
    feed.current = null;
    setRunning(false);
    setScore(null);
  };

  const start = async (wav?: ArrayBuffer) => {
    setError("");
    stop();
    const model = WAKE_MODELS[modelKey];
    const d = createWakeDetector({
      model,
      cutoff,
      onWake: (detection) => {
        setHits((h) => [{ at: new Date().toLocaleTimeString(), d: detection }, ...h].slice(0, 8));
        setFlash((n) => n + 1);
        beacon({ type: "wake", t: Date.now(), ...detection, visibility: document.visibilityState, focus: document.hasFocus() });
      },
      onScore: (s) => {
        last.current = s;
        setScore(s);
      },
      onStats: (s) => {
        setStats(s);
        beacon({ type: "stats", t: Date.now(), ...s });
      },
      onError: (m) => setError(m),
    });
    det.current = d;
    try {
      if (!wav && feedUrl) wav = await (await fetch(feedUrl)).arrayBuffer();
      if (wav) {
        const f = await wavStream(wav);
        feed.current = f;
        await d.start(f.stream);
      } else {
        await d.start();
      }
      if (det.current !== d) return; // stopped meanwhile
      started.current = performance.now();
      setRunning(true);
    } catch (err) {
      if (det.current === d) stop();
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (autostart) void start();
    return () => det.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat for background tests: is audio still being processed while
  // the window is unfocused / hidden / minimized?
  useEffect(() => {
    if (!logUrl) return;
    const id = setInterval(() => {
      const s = last.current;
      beacon({
        type: "tick",
        t: Date.now(),
        running: Boolean(det.current?.running),
        audioSec: s?.audioSec ?? 0,
        wallSec: started.current ? (performance.now() - started.current) / 1000 : 0,
        score: s?.score ?? 0,
        peak: s?.peak ?? 0,
        active: s?.active ?? false,
        levelDb: s?.levelDb ?? -120,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Desktop background test (VITE_WAKE_BGTEST=1, Tauri only): minimize, then
  // hide, the window from inside the page and restore it on a timer, logging
  // phase markers, so the logger shows what kept running in each state. If
  // the page is frozen while hidden, the restore timer itself is late, which
  // the log shows too.
  useEffect(() => {
    if (env.VITE_WAKE_BGTEST !== "1") return;
    type Win = { minimize(): Promise<void>; unminimize(): Promise<void>; hide(): Promise<void>; show(): Promise<void>; setFocus(): Promise<void> };
    const tauri = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow(): Win } } }).__TAURI__;
    const win = tauri?.window?.getCurrentWindow();
    if (!win) {
      beacon({ type: "phase", t: Date.now(), phase: "no-tauri-window-api" });
      return;
    }
    const at = (sec: number, phase: string, act: () => Promise<void>) =>
      setTimeout(() => {
        beacon({ type: "phase", t: Date.now(), phase });
        act().catch((e: unknown) => beacon({ type: "phase", t: Date.now(), phase: `${phase}-failed`, error: String(e) }));
      }, sec * 1000);
    const ids = [
      at(45, "minimize", () => win.minimize()),
      at(70, "unminimize", async () => {
        await win.unminimize();
        await win.setFocus();
      }),
      at(90, "hide", () => win.hide()),
      at(115, "show", async () => {
        await win.show();
        await win.setFocus();
      }),
      at(135, "done", async () => {}),
    ];
    return () => ids.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(0), 600);
    return () => clearTimeout(id);
  }, [flash]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const box: CSSProperties = {
    position: "fixed",
    right: 12,
    bottom: 12,
    zIndex: 99999,
    width: collapsed ? "auto" : 300,
    padding: 10,
    borderRadius: 10,
    font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#e8e8e8",
    background: flash ? "#1f6f3a" : "rgba(20,20,24,0.92)",
    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
    transition: "background 200ms",
  };
  const bar = (value: number, color: string) => (
    <div style={{ position: "relative", height: 10, background: "#333", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: pct(value), height: "100%", background: color }} />
      <div style={{ position: "absolute", left: pct(cutoff), top: 0, bottom: 0, width: 2, background: "#f5c542" }} />
    </div>
  );

  return (
    <div style={box} data-testid="wake-debug" data-running={running} data-hits={hits.length}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>Wake word {flash ? "— heard!" : ""}</strong>
        <button type="button" onClick={() => setCollapsed((c) => !c)} style={{ font: "inherit" }}>
          {collapsed ? "+" : "–"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div style={{ display: "flex", gap: 6, margin: "6px 0" }}>
            <select
              value={modelKey}
              disabled={running}
              onChange={(e) => {
                const k = e.target.value as ModelKey;
                setModelKey(k);
                setCutoff(WAKE_MODELS[k].cutoff);
              }}
            >
              {Object.entries(WAKE_MODELS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.phrase}
                </option>
              ))}
            </select>
            {running ? (
              <button type="button" onClick={stop}>Stop</button>
            ) : (
              <button type="button" onClick={() => void start()} data-testid="wake-start">Start mic</button>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <input
                type="checkbox"
                checked={armed}
                onChange={(e) => {
                  setArmed(e.target.checked);
                  det.current?.setArmed(e.target.checked);
                }}
              />
              armed
            </label>
          </div>
          <div>score {score ? pct(score.score) : "—"}</div>
          {bar(score?.score ?? 0, "#4caf50")}
          <div style={{ marginTop: 4 }}>peak (3 s) {score ? pct(score.peak) : "—"}</div>
          {bar(score?.peak ?? 0, "#2196f3")}
          <label style={{ display: "block", marginTop: 6 }}>
            cutoff {cutoff.toFixed(2)}
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={cutoff}
              style={{ width: "100%" }}
              onChange={(e) => {
                const v = Number(e.target.value);
                setCutoff(v);
                det.current?.setCutoff(v);
              }}
            />
          </label>
          <div style={{ opacity: 0.8 }}>
            {score
              ? `${score.listening ? (score.active ? "listening, model running" : "listening, gate idle") : "deaf"} · ${score.levelDb.toFixed(0)} dBFS · ${score.audioSec.toFixed(0)} s audio`
              : running
                ? "starting…"
                : "stopped"}
          </div>
          {stats && (
            <div style={{ opacity: 0.8 }}>
              {`${stats.meanMs.toFixed(3)} ms/step (max ${stats.maxMs.toFixed(2)}) · worker ${stats.workerBusyPct.toFixed(1)}% · model on ${stats.activePct.toFixed(0)}%`}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
            <button type="button" onClick={() => det.current?.holdOff(3000)} disabled={!running}>
              hold off 3 s
            </button>
            <label>
              feed WAV{" "}
              <input
                type="file"
                accept="audio/*"
                style={{ width: 110 }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) await start(await file.arrayBuffer());
                }}
              />
            </label>
          </div>
          {error && <div style={{ color: "#ff8a80", marginTop: 4 }}>{error}</div>}
          {hits.length > 0 && (
            <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {hits.map((h, i) => (
                <li key={i}>
                  {h.at} {h.d.phrase} ({pct(h.d.score)})
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
