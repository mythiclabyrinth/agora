/* Instance-admin Settings: shell for instance-wide options.
   Today: Features + Credentials for voice / Ask AI. More tabs can land here later. */

import { useEffect, useRef, useState } from "react";
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

const TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

function SttFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const [sttProvider, setSttProvider] = useState(data.stt_provider);

  useEffect(() => {
    setSttProvider(data.stt_provider);
  }, [data.stt_provider]);

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Speech-to-text settings saved", { variant: "ok" }),
      onError: e => toast(`Couldn't save: ${(e as Error).message || e}`, { variant: "warn" }),
    });
  };

  const sttProviders = data.stt_providers?.length
    ? data.stt_providers
    : [
        { id: "openai", label: "OpenAI" },
        { id: "groq", label: "Groq" },
      ];
  const stt = (data.stt_models?.[sttProvider as "openai" | "groq"] || data.stt_model).value;
  const suggested = data.suggested_stt_models_by_provider?.[sttProvider]
    || data.suggested_stt_models
    || [];

  return (
    <div className="ai-section">
      <SectionHead
        title="Voice — speech to text"
        available={data.stt_available}
        enabled={data.stt_enabled}
        onEnabled={stt_enabled => save({ stt_enabled })}
      />
      <p className="conn-hint">Voice notes: the composer microphone.</p>
      <div className="ai-row">
        <label>Provider</label>
        <select
          value={sttProvider}
          disabled={update.isPending}
          onChange={e => {
            const next = e.target.value;
            setSttProvider(next);
            save({ stt_provider: next });
          }}
        >
          {sttProviders.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="ai-row">
        <label>Model</label>
        <select
          value={stt}
          disabled={update.isPending}
          onChange={e => save({ stt_model: e.target.value, stt_model_provider: sttProvider })}
        >
          {suggested.map(m => <option key={m} value={m}>{m}</option>)}
          {stt && !suggested.includes(stt) && <option value={stt}>{stt}</option>}
        </select>
      </div>
    </div>
  );
}

function TtsFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Text-to-speech settings saved", { variant: "ok" }),
      onError: e => toast(`Couldn't save: ${(e as Error).message || e}`, { variant: "warn" }),
    });
  };

  const ttsProviders = data.tts_providers?.length
    ? data.tts_providers
    : [{ id: "openai", label: "OpenAI" }];
  const tts = data.tts_model.value;
  const voice = data.tts_voice.value;
  const voices = data.suggested_tts_voices;

  return (
    <div className="ai-section">
      <SectionHead
        title="Voice — text to speech"
        available={data.tts_available}
        enabled={data.tts_enabled}
        onEnabled={tts_enabled => save({ tts_enabled })}
      />
      <p className="conn-hint">Speak-aloud, and live voice together with speech to text.</p>
      <div className="ai-row">
        <label>Provider</label>
        <select
          value={data.tts_provider}
          disabled={update.isPending}
          onChange={e => save({ tts_provider: e.target.value })}
        >
          {ttsProviders.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="ai-row">
        <label>Model</label>
        <select
          value={tts}
          disabled={update.isPending}
          onChange={e => save({ tts_model: e.target.value })}
        >
          {TTS_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          {tts && !TTS_MODELS.includes(tts) && <option value={tts}>{tts}</option>}
        </select>
      </div>
      <div className="ai-row">
        <label>Voice</label>
        <select
          value={voice}
          disabled={update.isPending}
          onChange={e => save({ tts_voice: e.target.value })}
        >
          {voices.map(v => <option key={v} value={v}>{v}</option>)}
          {voice && !voices.includes(voice) && <option value={voice}>{voice}</option>}
        </select>
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
        { id: "codex", label: "Codex OAuth" },
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
  label, field, placeholder, onSave, onClear, onTest, testing,
}: {
  label: string;
  field: InstanceAiSettings["credentials"]["openai"];
  placeholder: string;
  onSave: (key: string) => void;
  onClear: () => void;
  onTest: () => void;
  testing: boolean;
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
        <div className="ai-key-actions">
          <button className="btn sm primary" disabled={!key.trim()}
            onClick={() => { onSave(key.trim()); setKey(""); }}>
            Save
          </button>
          {field.configured && (
            <button className="btn sm" disabled={testing} onClick={onTest}>
              {testing ? "Testing…" : "Test"}
            </button>
          )}
          {field.source === "config" && (
            <button className="btn sm danger" onClick={onClear}>Clear</button>
          )}
        </div>
      </div>
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
  const oauthWinRef = useRef<Window | null>(null);
  const statusQ = useCodexOauthStatus(oauthMode === "loopback");

  const closeOauthWindow = () => {
    try { oauthWinRef.current?.close(); } catch { /* ignore */ }
    oauthWinRef.current = null;
  };

  useEffect(() => {
    if (statusQ.data?.status === "completed") {
      toast("Codex OAuth complete", { variant: "ok" });
      closeOauthWindow();
      setOauthMode(null);
      setAuthorizeUrl("");
    } else if (statusQ.data?.status === "failed") {
      toast(`Codex OAuth failed: ${statusQ.data.error || "unknown"}`, { variant: "warn" });
      closeOauthWindow();
      setOauthMode(null);
    }
  }, [statusQ.data?.status, statusQ.data?.error]);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const oauth = data.credentials.oauth;

  return (
    <>
      <KeyRow
        label="OpenAI"
        field={data.credentials.openai}
        placeholder="sk-…"
        testing={test.isPending}
        onSave={api_key => update.mutate({ credentials: { openai: { api_key } } }, {
          onSuccess: () => toast("OpenAI key saved", { variant: "ok" }),
          onError: err("Couldn't save OpenAI key"),
        })}
        onClear={() => update.mutate({ credentials: { openai: { clear_key: true } } }, {
          onSuccess: () => toast("OpenAI key cleared", { variant: "ok" }),
          onError: err("Couldn't clear OpenAI key"),
        })}
        onTest={() => test.mutate("openai", {
          onSuccess: () => toast("OpenAI credentials work", { variant: "ok" }),
          onError: err("OpenAI test failed"),
        })}
      />

      <KeyRow
        label="Groq"
        field={data.credentials.groq}
        placeholder="gsk-…"
        testing={test.isPending}
        onSave={api_key => update.mutate({ credentials: { groq: { api_key } } }, {
          onSuccess: () => toast("Groq key saved", { variant: "ok" }),
          onError: err("Couldn't save Groq key"),
        })}
        onClear={() => update.mutate({ credentials: { groq: { clear_key: true } } }, {
          onSuccess: () => toast("Groq key cleared", { variant: "ok" }),
          onError: err("Couldn't clear Groq key"),
        })}
        onTest={() => test.mutate("groq", {
          onSuccess: () => toast("Groq credentials work", { variant: "ok" }),
          onError: err("Groq test failed"),
        })}
      />

      <KeyRow
        label="Anthropic"
        field={data.credentials.anthropic}
        placeholder="sk-ant-…"
        testing={test.isPending}
        onSave={api_key => update.mutate({ credentials: { anthropic: { api_key } } }, {
          onSuccess: () => toast("Anthropic key saved", { variant: "ok" }),
          onError: err("Couldn't save Anthropic key"),
        })}
        onClear={() => update.mutate({ credentials: { anthropic: { clear_key: true } } }, {
          onSuccess: () => toast("Anthropic key cleared", { variant: "ok" }),
          onError: err("Couldn't clear Anthropic key"),
        })}
        onTest={() => test.mutate("anthropic", {
          onSuccess: () => toast("Anthropic credentials work", { variant: "ok" }),
          onError: err("Anthropic test failed"),
        })}
      />

      <div className="ai-section">
        <h4>Codex</h4>
        <div className="ai-key">
          <span className="dim">
            {oauth.configured
              ? `${oauth.hint || "linked"}${oauth.account_id ? ` · ${oauth.account_id}` : ""}`
              : "not linked"}
          </span>
          <div className="ai-key-actions">
            <button className="btn sm primary" disabled={startOauth.isPending}
              onClick={() => {
                const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
                const mode = local ? "loopback" : "paste";
                startOauth.mutate(mode, {
                  onSuccess: res => {
                    setOauthMode(res.mode);
                    setAuthorizeUrl(res.authorize_url);
                    // Keep a window handle so we can close it on success.
                    // Do not use noopener — that makes window.open return null.
                    oauthWinRef.current = window.open(res.authorize_url, "agora-codex-oauth");
                    toast(mode === "loopback"
                      ? "Sign in opened — finish in the Codex OAuth window"
                      : "Sign in opened — paste the redirected localhost URL below", { variant: "ok" });
                  },
                  onError: err("Couldn't start Codex OAuth"),
                });
              }}>
              {oauth.configured ? "Reconnect" : "Connect"}
            </button>
            {oauth.configured && (
              <button className="btn sm" disabled={test.isPending}
                onClick={() => test.mutate("codex", {
                  onSuccess: () => toast("Codex OAuth credentials work", { variant: "ok" }),
                  onError: err("Codex OAuth test failed"),
                })}>
                {test.isPending ? "Testing…" : "Test"}
              </button>
            )}
            {oauth.configured && (
              <button className="btn sm danger" disabled={disconnectOauth.isPending}
                onClick={() => disconnectOauth.mutate(undefined, {
                  onSuccess: () => toast("Codex OAuth disconnected", { variant: "ok" }),
                  onError: err("Couldn't disconnect"),
                })}>
                Clear
              </button>
            )}
          </div>
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
                    toast("Codex OAuth complete", { variant: "ok" });
                    closeOauthWindow();
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
                If the window didn&apos;t open: <a href={authorizeUrl} target="agora-codex-oauth" rel="noreferrer">open authorize URL</a>
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
  const open = ui.panel === "settings";
  const q = useInstanceAi(open && !!me?.instance_admin);
  const [tab, setTab] = useState<"features" | "credentials">("features");

  if (!open) return null;

  return (
    <div className="conn-overlay" id="settings-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="settings-panel">
        <div className="conn-head">
          <b>Settings</b>
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
                Choose providers and models. Keys and Codex OAuth live under Credentials.
              </p>
              <SttFeatures data={q.data.voice} />
              <TtsFeatures data={q.data.voice} />
              <SearchFeatures data={q.data.search} />
            </>
          )}
          {q.data && tab === "credentials" && (
            <>
              <p className="conn-hint">
                Add a key for each provider you use, then press Test to make sure it works.
              </p>
              <CredentialsTab data={q.data} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
