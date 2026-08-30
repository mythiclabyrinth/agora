/* Agent profile overlay: avatar + everything /api/agents knows about the
   agent. Instance admins can set spoken accent/voice for agents Agora owns
   (pairing / dial-in). Pantheo agents show the voice their hello advertised. */

import { useEffect, useState } from "react";
import {
  useAgents,
  useAgentUsage,
  useInstanceAi,
  useMe,
  useUpdateAgentTts,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { withToken } from "../lib/files";
import { toast } from "../lib/toast";
import { useAgentProfile } from "./MessageItem";

function relTime(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AgentProfileCard() {
  const { openId, close } = useAgentProfile();
  const agents = useAgents().data || [];
  const me = useMe();
  if (!openId) return null;
  const a = agents.find(x => x.id === openId);
  if (!a) return null;
  const admin = !!me.data?.instance_admin;

  return (
    <div className="conn-overlay" id="ago-profile-overlay"
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="conn-panel ago-profile-panel">
        <div className="ago-profile-top">
          {a.avatar
            ? <span className="ago-av profile has-avatar"><img src={withToken(a.avatar)} alt="" /></span>
            : <span className="ago-av profile"><Icon name="bot" /></span>}
          <div className="ago-profile-id">
            <div className="ago-profile-name">{a.name || a.id}</div>
            <div className="ago-profile-sub dim">@{a.id} · agent</div>
          </div>
          <button className="btn sm ago-profile-close" onClick={close}><Icon name="x" /></button>
        </div>
        <div className="ago-profile-rows">
          <div className="ago-profile-row">
            <span className="k">Status</span>
            <span className="v">
              {a.live
                ? <><span className="ago-live-dot"></span> Online</>
                : <><span className="ago-off">Offline</span>{a.last_seen ? ` · last seen ${relTime(a.last_seen)}` : ""}</>}
            </span>
          </div>
          {a.source && (
            <div className="ago-profile-row"><span className="k">Connection</span><span className="v">{a.source}</span></div>
          )}
          <div className="ago-profile-row">
            <span className="k">Responds</span>
            <span className="v">{a.requires_mention ? "Only when @-mentioned" : "To every message in its channels"}</span>
          </div>
          <AgentUsageRows agentId={a.id} live={a.live} />
          <AgentVoiceRows agentId={a.id} admin={admin} />
        </div>
      </div>
    </div>
  );
}

function AgentUsageRows({ agentId, live }: { agentId: string; live: boolean }) {
  const query = useAgentUsage(agentId);
  const response = query.data;
  const usage = response?.usage;
  if (query.isLoading) {
    return null;
  }
  if (!usage) {
    return null;
  }
  if (usage.availability === "external") {
    return (
      <div className="ago-usage-section">
        <div className="ago-usage-head"><strong>Usage</strong><span>Cursor reports usage in its dashboard</span></div>
        {usage.external_url && <a className="ago-usage-link" href={usage.external_url} target="_blank" rel="noreferrer">Open usage dashboard</a>}
      </div>
    );
  }
  const age = Math.max(0, Date.now() / 1000 - usage.captured_at);
  const freshness = age < 60 ? "Updated just now" : `Updated ${relTime(usage.captured_at)}`;
  return (
    <div className="ago-usage-section">
      <div className="ago-usage-head">
        <strong>Usage{usage.plan ? ` · ${usage.plan}` : ""}</strong>
        <span>{response?.refreshing ? "Updating…" : freshness}{!live ? " · agent offline" : response?.stale ? " · may be outdated" : ""}</span>
      </div>
      {usage.windows.map(window => (
        <div className="ago-usage-window" key={window.key}>
          <div><span>{window.label}</span><strong>{Math.round(window.used_percent)}% used</strong></div>
          <div className="ago-usage-track" role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.used_percent)}>
            <span style={{ width: `${Math.max(0, Math.min(100, window.used_percent))}%` }} />
          </div>
          {window.resets_at && <small>Resets {new Date(window.resets_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>}
        </div>
      ))}
      {usage.credits?.unlimited ? <div className="ago-usage-credit">Credits: unlimited</div>
        : usage.credits?.has_credits ? <div className="ago-usage-credit">Credit balance: {usage.credits.balance ?? "available"}</div> : null}
    </div>
  );
}

function AgentVoiceRows({ agentId, admin }: { agentId: string; admin: boolean }) {
  const agents = useAgents().data || [];
  const a = agents.find(x => x.id === agentId);
  const editable = admin && !!a?.tts_editable;
  const ai = useInstanceAi(editable);
  const update = useUpdateAgentTts(agentId);
  const ttsProvider = ai.data?.voice.tts_provider || "openai";
  const accents = ai.data?.voice.tts_accents || [
    { id: "american", label: "American English" },
    { id: "british", label: "British English" },
    { id: "arabic", label: "Arabic (Saudi)" },
  ];
  const voiceOptions = ai.data?.voice.suggested_tts_voice_options_by_provider?.[ttsProvider]
    || ai.data?.voice.suggested_tts_voice_options
    || [];
  const [accent, setAccent] = useState(a?.tts_accent || "american");
  const currentVoice = (ttsProvider === "groq" ? a?.tts_voices?.groq : a?.tts_voices?.openai) || "";
  const [voice, setVoice] = useState(currentVoice);

  useEffect(() => {
    setAccent(a?.tts_accent || "american");
    setVoice((ttsProvider === "groq" ? a?.tts_voices?.groq : a?.tts_voices?.openai) || "");
  }, [a?.tts_accent, a?.tts_voices?.groq, a?.tts_voices?.openai, ttsProvider]);

  if (!a) return null;

  const save = (patch: { tts_accent?: string; tts_voices?: { openai?: string; groq?: string } }) => {
    update.mutate(patch, {
      onSuccess: () => toast("Agent voice saved", { variant: "ok" }),
      onError: e => toast(`Couldn't save: ${(e as Error).message || e}`, { variant: "warn" }),
    });
  };

  const accentLabel = a.tts_accent_label
    || accents.find(x => x.id === a.tts_accent)?.label
    || (a.tts_accent ? a.tts_accent : "Instance default");
  const voiceLabel = ttsProvider === "groq"
    ? (a.tts_voice_labels?.groq || a.tts_voices?.groq || "Instance default")
    : (a.tts_voice_labels?.openai || a.tts_voices?.openai || "Instance default");

  if (!editable) {
    return (
      <>
        <div className="ago-profile-row">
          <span className="k">Accent</span>
          <span className="v">{accentLabel}{a.tts_editable === false ? " · set in Pantheo" : ""}</span>
        </div>
        <div className="ago-profile-row">
          <span className="k">Voice</span>
          <span className="v">{voiceLabel}</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="ago-profile-row">
        <span className="k">Accent</span>
        <span className="v">
          <select
            className="ago-profile-select"
            value={accent}
            disabled={update.isPending}
            onChange={e => {
              const next = e.target.value;
              setAccent(next);
              save({ tts_accent: next });
            }}
          >
            <option value="">Instance default</option>
            {accents.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
        </span>
      </div>
      <div className="ago-profile-row">
        <span className="k">Voice</span>
        <span className="v">
          <select
            className="ago-profile-select"
            value={voice}
            disabled={update.isPending || !ai.data}
            onChange={e => {
              const next = e.target.value;
              setVoice(next);
              save({
                tts_voices: ttsProvider === "groq" ? { groq: next } : { openai: next },
              });
            }}
          >
            <option value="">Instance default</option>
            {voiceOptions.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
            {voice && !voiceOptions.some(o => o.id === voice) && (
              <option value={voice}>{voice}</option>
            )}
          </select>
        </span>
      </div>
    </>
  );
}
