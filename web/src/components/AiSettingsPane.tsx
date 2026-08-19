/* Instance-admin AI & voice settings: keys (masked), models, enable toggles,
   and a Test connection probe. Secrets never round-trip in plaintext. */

import { useEffect, useState } from "react";
import {
  useInstanceAi, useMe, useTestInstanceAi, useUpdateInstanceAi,
  type InstanceAiSettings, type InstanceAiUpdate,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

/* Model inputs hold the *override*, not the resolved value: empty means
   "follow the server env / built-in default", and the resolved value shows as
   the placeholder. Pre-filling them would make an unchanged save pin the stock
   model into config.json and permanently shadow AGORA_AI_MODEL. */
const override = (f: { value: string; source: string }) =>
  f.source === "config" ? f.value : "";

const inherited = (f: { value: string; source: string }) =>
  `${f.value} (${f.source === "env" ? "from env" : "default"})`;

function sourceLabel(source: string): string {
  switch (source) {
    case "config": return "saved in instance settings";
    case "env": return "from server environment";
    case "default": return "default";
    default: return "not set";
  }
}

function SectionHead({
  title, available, enabled, onEnabled,
}: {
  title: string;
  available: boolean;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
}) {
  return (
    <div className="ai-section-head">
      <h4>
        {title}{" "}
        <span className={`ai-pill ${available ? "on" : "off"}`}>
          {available ? "available" : "off"}
        </span>
      </h4>
      <label className="ai-toggle">
        <input type="checkbox" checked={enabled} onChange={e => onEnabled(e.target.checked)} />
        Enabled
      </label>
    </div>
  );
}

function VoiceForm({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const [key, setKey] = useState("");
  const [stt, setStt] = useState(override(data.stt_model));
  const [tts, setTts] = useState(override(data.tts_model));
  const [voice, setVoice] = useState(override(data.tts_voice));

  useEffect(() => {
    setStt(override(data.stt_model));
    setTts(override(data.tts_model));
    setVoice(override(data.tts_voice));
    setKey("");
  }, [data]);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Voice settings saved", { variant: "ok" }),
      onError: err("Couldn't save voice settings"),
    });
  };

  return (
    <div className="ai-section">
      <SectionHead
        title="Voice"
        available={data.available}
        enabled={data.enabled}
        onEnabled={enabled => save({ enabled })}
      />
      <p className="conn-hint">
        Provider <b>{data.provider}</b> — voice notes, speak-aloud, and live voice.
        Endpoints are fixed (OpenAI); base URLs are not configurable.
      </p>
      <div className="ai-row">
        <label>API key</label>
        <div className="ai-key">
          <span className="dim">
            {data.api_key.configured
              ? `${data.api_key.hint} · ${sourceLabel(data.api_key.source)}`
              : sourceLabel(data.api_key.source)}
          </span>
          <input
            type="password"
            autoComplete="off"
            placeholder={data.api_key.configured ? "replace key…" : "sk-…"}
            value={key}
            onChange={e => setKey(e.target.value)}
          />
          <button className="btn sm primary" disabled={!key.trim() || update.isPending}
            onClick={() => { save({ api_key: key.trim() }); setKey(""); }}>
            Save key
          </button>
          {data.api_key.source === "config" && (
            <button className="btn sm danger" disabled={update.isPending}
              onClick={() => save({ clear_key: true })}>
              Clear saved key
            </button>
          )}
        </div>
      </div>
      <div className="ai-row">
        <label>STT model</label>
        <input value={stt} placeholder={inherited(data.stt_model)}
          onChange={e => setStt(e.target.value)} />
      </div>
      <div className="ai-row">
        <label>TTS model</label>
        <input value={tts} placeholder={inherited(data.tts_model)}
          onChange={e => setTts(e.target.value)} />
      </div>
      <div className="ai-row">
        <label>TTS voice</label>
        <select value={voice} onChange={e => setVoice(e.target.value)}>
          <option value="">{inherited(data.tts_voice)}</option>
          {(data.suggested_tts_voices.includes(voice) || !voice
            ? data.suggested_tts_voices
            : [voice, ...data.suggested_tts_voices]
          ).map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <p className="conn-hint">Leave a field empty to follow the server environment or the built-in default.</p>
      <div className="ai-actions">
        <button className="btn sm primary" disabled={update.isPending}
          onClick={() => save({
            stt_model: stt.trim(),
            tts_model: tts.trim(),
            tts_voice: voice.trim(),
          })}>
          Save models
        </button>
        <button className="btn sm" disabled={test.isPending || !data.api_key.configured}
          onClick={() => test.mutate("voice", {
            onSuccess: () => toast("OpenAI key works", { variant: "ok" }),
            onError: err("Voice test failed"),
          })}>
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
      </div>
    </div>
  );
}

function SearchForm({ data }: { data: InstanceAiSettings["search"] }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(override(data.model));

  useEffect(() => {
    setModel(override(data.model));
    setKey("");
  }, [data]);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const save = (patch: NonNullable<InstanceAiUpdate["search"]>) => {
    update.mutate({ search: patch }, {
      onSuccess: () => toast("Ask AI settings saved", { variant: "ok" }),
      onError: err("Couldn't save Ask AI settings"),
    });
  };

  return (
    <div className="ai-section">
      <SectionHead
        title="Ask AI (search answers)"
        available={data.available}
        enabled={data.enabled}
        onEnabled={enabled => save({ enabled })}
      />
      <p className="conn-hint">
        Provider <b>{data.provider}</b> — synthesizes cited answers over FTS hits.
        Plain search needs no key. Endpoints are fixed (Anthropic).
      </p>
      <div className="ai-row">
        <label>API key</label>
        <div className="ai-key">
          <span className="dim">
            {data.api_key.configured
              ? `${data.api_key.hint} · ${sourceLabel(data.api_key.source)}`
              : sourceLabel(data.api_key.source)}
          </span>
          <input
            type="password"
            autoComplete="off"
            placeholder={data.api_key.configured ? "replace key…" : "sk-ant-…"}
            value={key}
            onChange={e => setKey(e.target.value)}
          />
          <button className="btn sm primary" disabled={!key.trim() || update.isPending}
            onClick={() => { save({ api_key: key.trim() }); setKey(""); }}>
            Save key
          </button>
          {data.api_key.source === "config" && (
            <button className="btn sm danger" disabled={update.isPending}
              onClick={() => save({ clear_key: true })}>
              Clear saved key
            </button>
          )}
        </div>
      </div>
      <div className="ai-row">
        <label>Model</label>
        <input list="ai-search-models" value={model} placeholder={inherited(data.model)}
          onChange={e => setModel(e.target.value)} />
        <datalist id="ai-search-models">
          {data.suggested_models.map(m => <option key={m} value={m} />)}
        </datalist>
      </div>
      <p className="conn-hint">Leave empty to follow <code>AGORA_AI_MODEL</code> or the built-in default.</p>
      <div className="ai-actions">
        <button className="btn sm primary" disabled={update.isPending}
          onClick={() => save({ model: model.trim() })}>
          Save model
        </button>
        <button className="btn sm" disabled={test.isPending || !data.api_key.configured}
          onClick={() => test.mutate("search", {
            onSuccess: () => toast("Anthropic key works", { variant: "ok" }),
            onError: err("Ask AI test failed"),
          })}>
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
      </div>
    </div>
  );
}

export function AiSettingsPane() {
  const ui = useUiState();
  const me = useMe().data;
  const open = ui.panel === "ai";
  const q = useInstanceAi(open && !!me?.instance_admin);

  if (!open) return null;

  return (
    <div className="conn-overlay" id="ai-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="ai-panel">
        <div className="conn-head">
          <b>AI &amp; voice</b>
          <button className="btn sm" onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-body">
          <p className="conn-hint">
            Instance-admin settings for voice transcription/speech and Ask AI over search.
            Keys may also come from the server environment; clearing a saved key falls back to env.
          </p>
          {q.isLoading && <div className="dim conn-empty">Loading…</div>}
          {q.isError && <div className="dim conn-empty">Couldn&apos;t load AI settings.</div>}
          {q.data && (
            <>
              <VoiceForm data={q.data.voice} />
              <SearchForm data={q.data.search} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
