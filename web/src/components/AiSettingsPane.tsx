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
  const [provider, setProvider] = useState(data.provider);
  const [authPaste, setAuthPaste] = useState("");
  const [refreshPaste, setRefreshPaste] = useState("");

  useEffect(() => {
    setModel(override(data.model));
    setProvider(data.provider);
    setKey("");
    setAuthPaste("");
    setRefreshPaste("");
  }, [data]);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const save = (patch: NonNullable<InstanceAiUpdate["search"]>) => {
    update.mutate({ search: patch }, {
      onSuccess: () => toast("Ask AI settings saved", { variant: "ok" }),
      onError: err("Couldn't save Ask AI settings"),
    });
  };

  const isCodex = provider === "codex";
  const isOpenAi = provider === "openai";
  const keyPlaceholder = isOpenAi ? "sk-…" : "sk-ant-…";
  const canTest = isCodex ? data.oauth.configured : data.api_key.configured;
  const providers = data.providers?.length
    ? data.providers
    : ["anthropic", "openai", "codex"];

  return (
    <div className="ai-section">
      <SectionHead
        title="Ask AI (search answers)"
        available={data.available}
        enabled={data.enabled}
        onEnabled={enabled => save({ enabled })}
      />
      <p className="conn-hint">
        Synthesizes cited answers over FTS hits. Plain search needs no key.
        Endpoints are fixed per provider (no custom base URL).
      </p>
      <div className="ai-row">
        <label>Provider</label>
        <select
          value={provider}
          onChange={e => {
            const next = e.target.value;
            setProvider(next);
            save({ provider: next });
          }}
          disabled={update.isPending}
        >
          {providers.map(p => (
            <option key={p} value={p}>
              {p === "codex" ? "codex (ChatGPT OAuth)" : p === "openai" ? "openai (API key)" : "anthropic (API key)"}
            </option>
          ))}
        </select>
      </div>
      {isCodex ? (
        <>
          <div className="ai-row">
            <label>ChatGPT OAuth</label>
            <div className="ai-key">
              <span className="dim">
                {data.oauth.configured
                  ? `${data.oauth.hint || "linked"} · ${sourceLabel(data.oauth.source)}${
                      data.oauth.account_id ? ` · ${data.oauth.account_id}` : ""
                    }`
                  : "not set — import from `codex login`"}
              </span>
              <button className="btn sm" disabled={update.isPending}
                title="Reads ~/.codex/auth.json on this server host"
                onClick={() => save({ import_local_codex_auth: true, provider: "codex" })}>
                Import from ~/.codex
              </button>
              {data.oauth.configured && (
                <button className="btn sm danger" disabled={update.isPending}
                  onClick={() => save({ clear_oauth: true })}>
                  Clear OAuth
                </button>
              )}
            </div>
          </div>
          <div className="ai-row">
            <label>Paste auth.json</label>
            <textarea
              rows={3}
              autoComplete="off"
              spellCheck={false}
              placeholder='{"tokens":{"access_token":"…","refresh_token":"…","account_id":"…"}}'
              value={authPaste}
              onChange={e => setAuthPaste(e.target.value)}
            />
            <button className="btn sm primary" disabled={!authPaste.trim() || update.isPending}
              onClick={() => {
                save({ codex_auth_json: authPaste.trim(), provider: "codex" });
                setAuthPaste("");
              }}>
              Import paste
            </button>
          </div>
          <div className="ai-row">
            <label>Or refresh token</label>
            <div className="ai-key">
              <input
                type="password"
                autoComplete="off"
                placeholder="rt_…"
                value={refreshPaste}
                onChange={e => setRefreshPaste(e.target.value)}
              />
              <button className="btn sm primary" disabled={!refreshPaste.trim() || update.isPending}
                onClick={() => {
                  save({ codex_refresh_token: refreshPaste.trim(), provider: "codex" });
                  setRefreshPaste("");
                }}>
                Save token
              </button>
            </div>
          </div>
        </>
      ) : (
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
              placeholder={data.api_key.configured ? "replace key…" : keyPlaceholder}
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
      )}
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
        <button className="btn sm" disabled={test.isPending || !canTest}
          onClick={() => test.mutate("search", {
            onSuccess: () => toast(
              isCodex ? "Codex OAuth works" : isOpenAi ? "OpenAI key works" : "Anthropic key works",
              { variant: "ok" },
            ),
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
