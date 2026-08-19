/* Instance-admin AI & voice settings.
   Features tab = provider + models (no secrets).
   Credentials tab = OpenAI/Anthropic keys + ChatGPT OAuth. */

import { useEffect, useState } from "react";
import {
  useCompleteCodexOauth,
  useDisconnectCodexOauth,
  useInstanceAi,
  useMe,
  useStartCodexOauth,
  useCodexOauthStatus,
  useTestInstanceAi,
  useUpdateInstanceAi,
  type InstanceAiSettings,
  type InstanceAiUpdate,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

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
  title, available, enabled, onEnabled, hint,
}: {
  title: string;
  available: boolean;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  hint?: string;
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
      {hint && !available && enabled && <p className="conn-hint">{hint}</p>}
    </div>
  );
}

function VoiceFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const [stt, setStt] = useState(override(data.stt_model));
  const [tts, setTts] = useState(override(data.tts_model));
  const [voice, setVoice] = useState(override(data.tts_voice));

  useEffect(() => {
    setStt(override(data.stt_model));
    setTts(override(data.tts_model));
    setVoice(override(data.tts_voice));
  }, [data]);

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Voice settings saved", { variant: "ok" }),
      onError: e => toast(`Couldn't save: ${(e as Error).message || e}`, { variant: "warn" }),
    });
  };

  return (
    <div className="ai-section">
      <SectionHead
        title="Voice"
        available={data.available}
        enabled={data.enabled}
        onEnabled={enabled => save({ enabled })}
        hint="Add an OpenAI API key under Credentials."
      />
      <p className="conn-hint">Provider OpenAI — voice notes, speak-aloud, live voice.</p>
      <div className="ai-row">
        <label>STT model</label>
        <input list="ai-stt-models" value={stt} placeholder={inherited(data.stt_model)}
          onChange={e => setStt(e.target.value)} />
        <datalist id="ai-stt-models">
          <option value="gpt-4o-mini-transcribe" />
          <option value="whisper-1" />
        </datalist>
      </div>
      <div className="ai-row">
        <label>TTS model</label>
        <input list="ai-tts-models" value={tts} placeholder={inherited(data.tts_model)}
          onChange={e => setTts(e.target.value)} />
        <datalist id="ai-tts-models">
          <option value="gpt-4o-mini-tts" />
          <option value="tts-1" />
          <option value="tts-1-hd" />
        </datalist>
      </div>
      <div className="ai-row">
        <label>TTS voice</label>
        <input list="ai-tts-voices" value={voice} placeholder={inherited(data.tts_voice)}
          onChange={e => setVoice(e.target.value)} />
        <datalist id="ai-tts-voices">
          {data.suggested_tts_voices.map(v => <option key={v} value={v} />)}
        </datalist>
      </div>
      <div className="ai-actions">
        <button className="btn sm primary" disabled={update.isPending}
          onClick={() => save({
            stt_model: stt.trim(),
            tts_model: tts.trim(),
            tts_voice: voice.trim(),
          })}>
          Save models
        </button>
      </div>
    </div>
  );
}

function SearchFeatures({ data }: { data: InstanceAiSettings["search"] }) {
  const update = useUpdateInstanceAi();
  const [provider, setProvider] = useState(data.provider);
  const modelField = data.models?.[provider as "anthropic" | "openai" | "codex"] || data.model;

  useEffect(() => {
    setProvider(data.provider);
  }, [data.provider]);

  const save = (patch: NonNullable<InstanceAiUpdate["search"]>) => {
    update.mutate({ search: patch }, {
      onSuccess: () => toast("Ask AI settings saved", { variant: "ok" }),
      onError: e => toast(`Couldn't save: ${(e as Error).message || e}`, { variant: "warn" }),
    });
  };

  const providers = data.providers?.length
    ? data.providers
    : [
        { id: "anthropic", label: "Anthropic (API key)" },
        { id: "openai", label: "OpenAI (API key)" },
        { id: "codex", label: "OpenAI via ChatGPT sign-in" },
      ];
  const suggested = data.suggested_models_by_provider?.[provider]
    || data.suggested_models
    || [];
  const selectedModel = modelField.value;

  return (
    <div className="ai-section">
      <SectionHead
        title="Ask AI"
        available={data.available}
        enabled={data.enabled}
        onEnabled={enabled => save({ enabled })}
        hint="Configure credentials under the Credentials tab."
      />
      <div className="ai-row">
        <label>Provider</label>
        <select
          value={provider}
          disabled={update.isPending}
          onChange={e => {
            const next = e.target.value;
            setProvider(next);
            save({ provider: next });
          }}
        >
          {providers.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="ai-row">
        <label>Model</label>
        <select
          value={selectedModel}
          disabled={update.isPending}
          onChange={e => {
            const next = e.target.value;
            save({ model: next, model_provider: provider });
          }}
        >
          {suggested.map(m => <option key={m} value={m}>{m}</option>)}
          {selectedModel && !suggested.includes(selectedModel) && (
            <option value={selectedModel}>{selectedModel}</option>
          )}
        </select>
      </div>
    </div>
  );
}

function KeyRow({
  label, field, placeholder, onSave, onClear,
}: {
  label: string;
  field: InstanceAiSettings["credentials"]["openai"];
  placeholder: string;
  onSave: (key: string) => void;
  onClear: () => void;
}) {
  const [key, setKey] = useState("");
  return (
    <div className="ai-section">
      <h4>{label}</h4>
      <div className="ai-key">
        <span className="dim">
          {field.configured
            ? `${field.hint} · ${sourceLabel(field.source)}`
            : sourceLabel(field.source)}
        </span>
        <input
          type="password"
          autoComplete="off"
          placeholder={field.configured ? "replace key…" : placeholder}
          value={key}
          onChange={e => setKey(e.target.value)}
        />
        <button className="btn sm primary" disabled={!key.trim()}
          onClick={() => { onSave(key.trim()); setKey(""); }}>
          Save key
        </button>
        {field.source === "config" && (
          <button className="btn sm danger" onClick={onClear}>Clear saved key</button>
        )}
      </div>
      {field.source === "env" && (
        <p className="conn-hint">From the server environment — saving a key here overrides it for this instance.</p>
      )}
    </div>
  );
}

function CredentialsTab({ data }: { data: InstanceAiSettings }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const startOauth = useStartCodexOauth();
  const completeOauth = useCompleteCodexOauth();
  const disconnectOauth = useDisconnectCodexOauth();
  const [oauthMode, setOauthMode] = useState<"loopback" | "paste" | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [redirectPaste, setRedirectPaste] = useState("");
  const statusQ = useCodexOauthStatus(oauthMode === "loopback");

  useEffect(() => {
    if (statusQ.data?.status === "completed") {
      toast("ChatGPT sign-in complete", { variant: "ok" });
      setOauthMode(null);
      setAuthorizeUrl("");
    } else if (statusQ.data?.status === "failed") {
      toast(`ChatGPT sign-in failed: ${statusQ.data.error || "unknown"}`, { variant: "warn" });
      setOauthMode(null);
    }
  }, [statusQ.data?.status, statusQ.data?.error]);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const oauth = data.credentials.oauth;

  return (
    <>
      <KeyRow
        label="OpenAI API key"
        field={data.credentials.openai}
        placeholder="sk-…"
        onSave={api_key => update.mutate({ credentials: { openai: { api_key } } }, {
          onSuccess: () => toast("OpenAI key saved", { variant: "ok" }),
          onError: err("Couldn't save OpenAI key"),
        })}
        onClear={() => update.mutate({ credentials: { openai: { clear_key: true } } }, {
          onSuccess: () => toast("OpenAI key cleared", { variant: "ok" }),
          onError: err("Couldn't clear OpenAI key"),
        })}
      />
      <div className="ai-actions">
        <button className="btn sm" disabled={test.isPending || !data.credentials.openai.configured}
          onClick={() => test.mutate("voice", {
            onSuccess: () => toast("OpenAI key works", { variant: "ok" }),
            onError: err("Voice test failed"),
          })}>
          {test.isPending ? "Testing…" : "Test OpenAI"}
        </button>
      </div>

      <KeyRow
        label="Anthropic API key"
        field={data.credentials.anthropic}
        placeholder="sk-ant-…"
        onSave={api_key => update.mutate({ credentials: { anthropic: { api_key } } }, {
          onSuccess: () => toast("Anthropic key saved", { variant: "ok" }),
          onError: err("Couldn't save Anthropic key"),
        })}
        onClear={() => update.mutate({ credentials: { anthropic: { clear_key: true } } }, {
          onSuccess: () => toast("Anthropic key cleared", { variant: "ok" }),
          onError: err("Couldn't clear Anthropic key"),
        })}
      />
      <div className="ai-actions">
        <button className="btn sm" disabled={test.isPending || !data.credentials.anthropic.configured}
          onClick={() => test.mutate("search", {
            onSuccess: () => toast("Anthropic / Ask AI works", { variant: "ok" }),
            onError: err("Ask AI test failed"),
          })}>
          Test Ask AI
        </button>
      </div>

      <div className="ai-section">
        <h4>ChatGPT sign-in (Codex)</h4>
        <p className="conn-hint">
          Uses your ChatGPT account via the Codex CLI OAuth client.
          {oauth.configured
            ? ` Linked · ${oauth.hint || "token saved"}${oauth.account_id ? ` · ${oauth.account_id}` : ""}`
            : " Not linked."}
        </p>
        <div className="ai-actions">
          <button className="btn sm primary" disabled={startOauth.isPending}
            onClick={() => {
              const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
              const mode = local ? "loopback" : "paste";
              startOauth.mutate(mode, {
                onSuccess: res => {
                  setOauthMode(res.mode);
                  setAuthorizeUrl(res.authorize_url);
                  window.open(res.authorize_url, "_blank", "noopener,noreferrer");
                  toast(mode === "loopback"
                    ? "Sign in opened — finish in the ChatGPT window"
                    : "Sign in opened — paste the redirected localhost URL below", { variant: "ok" });
                },
                onError: err("Couldn't start ChatGPT sign-in"),
              });
            }}>
            {oauth.configured ? "Re-authorize ChatGPT" : "Authorize ChatGPT"}
          </button>
          {oauth.configured && (
            <button className="btn sm danger" disabled={disconnectOauth.isPending}
              onClick={() => disconnectOauth.mutate(undefined, {
                onSuccess: () => toast("ChatGPT disconnected", { variant: "ok" }),
                onError: err("Couldn't disconnect"),
              })}>
              Disconnect
            </button>
          )}
        </div>
        {oauthMode === "loopback" && (
          <p className="conn-hint">Waiting for redirect on {oauth.redirect_uri}…</p>
        )}
        {oauthMode === "paste" && (
          <div className="ai-row">
            <label>Redirect URL</label>
            <div className="ai-key">
              <input
                value={redirectPaste}
                onChange={e => setRedirectPaste(e.target.value)}
                placeholder="http://localhost:1455/auth/callback?code=…"
                autoComplete="off"
              />
              <button className="btn sm primary" disabled={!redirectPaste.trim() || completeOauth.isPending}
                onClick={() => completeOauth.mutate(redirectPaste.trim(), {
                  onSuccess: () => {
                    toast("ChatGPT sign-in complete", { variant: "ok" });
                    setOauthMode(null);
                    setRedirectPaste("");
                  },
                  onError: err("Couldn't complete sign-in"),
                })}>
                Complete
              </button>
            </div>
            {authorizeUrl && (
              <p className="conn-hint">
                If the window didn&apos;t open: <a href={authorizeUrl} target="_blank" rel="noreferrer">open authorize URL</a>
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export function AiSettingsPane() {
  const ui = useUiState();
  const me = useMe().data;
  const open = ui.panel === "ai";
  const q = useInstanceAi(open && !!me?.instance_admin);
  const [tab, setTab] = useState<"features" | "credentials">("features");

  if (!open) return null;

  return (
    <div className="conn-overlay" id="ai-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="ai-panel">
        <div className="conn-head">
          <b>AI &amp; voice</b>
          <button className="btn sm" onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-tabs" role="tablist">
          <button type="button" role="tab" className={`conn-tab${tab === "features" ? " active" : ""}`}
            aria-selected={tab === "features"} onClick={() => setTab("features")}>
            Features
          </button>
          <button type="button" role="tab" className={`conn-tab${tab === "credentials" ? " active" : ""}`}
            aria-selected={tab === "credentials"} onClick={() => setTab("credentials")}>
            Credentials
          </button>
        </div>
        <div className="conn-body">
          {q.isLoading && <div className="dim conn-empty">Loading…</div>}
          {q.isError && <div className="dim conn-empty">Couldn&apos;t load AI settings.</div>}
          {q.data && tab === "features" && (
            <>
              <p className="conn-hint">
                Choose providers and models. Keys and ChatGPT sign-in live under Credentials.
              </p>
              <VoiceFeatures data={q.data.voice} />
              <SearchFeatures data={q.data.search} />
            </>
          )}
          {q.data && tab === "credentials" && (
            <>
              <p className="conn-hint">
                Environment keys show masked. Saving a key here overrides env for this instance;
                clear restores the env fallback.
              </p>
              <CredentialsTab data={q.data} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
