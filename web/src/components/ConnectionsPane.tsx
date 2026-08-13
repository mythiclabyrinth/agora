/* Admin-only connection manager. "Add agent" presents branded, guided setup
   for local coding CLIs alongside hosted agent integrations and Pantheo. */

import { useEffect, useRef, useState } from "react";
import {
  type PairingKind,
  type PairingToken,
  type AgentSource,
  agentWsUrl,
  inferPairingKind,
  useAgentDmPolicy, useAgentSources, useUpdateAgentDmPolicy, useUsers,
  useConnectionMutations, useConnectionsInfo, usePairingMutations, usePairingTokens,
  useRenameInstance,
} from "@agora/core";
import claudeLogo from "../assets/agents/claude.png";
import codexLogo from "../assets/agents/codex.png";
import cursorLogo from "../assets/agents/cursor.png";
import hermesLogo from "../assets/agents/hermes.png";
import openClawLogo from "../assets/agents/openclaw.png";
import pantheoLogo from "../assets/agents/pantheo.png";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { AgentAvatar } from "./AgentAvatar";
import { AgentStatus } from "./AgentStatus";

type Tab = "list" | "add";
type AddKind = "pantheo" | "coding" | PairingKind;
type ConnectableKind = Exclude<AddKind, "coding">;

function AgentAccessPolicy({ agent, onBack }: { agent: AgentSource["agents"][number]; onBack: () => void }) {
  const policy = useAgentDmPolicy(agent.id).data;
  const users = useUsers().data || [];
  const update = useUpdateAgentDmPolicy(agent.id);
  const [filter,setFilter]=useState("");
  const save = (is_public: boolean, grants: string[]) => update.mutate({ is_public, grants }, {
    onError: error => toast(`Couldn't update access: ${(error as Error).message}`, { variant: "warn" }),
  });
  return <div className="conn-access">
    <BackButton onClick={onBack} label="Back" />
    <div className="conn-access-title"><AgentAvatar agentId={agent.id} /><div><h3>{agent.name}</h3><AgentStatus live={agent.live} />{!agent.live && <p className="dim">Messages remain available in history</p>}</div></div>
    {!policy ? <p className="dim">Loading access…</p> : <>
      <div className="conn-access-public"><span><strong>Public</strong><small>Everyone on this Agora can start a direct message</small></span>
        <button type="button" className="conn-switch" role="switch" aria-checked={policy.is_public}
          aria-label="Public agent direct messages" disabled={update.isPending}
          onClick={() => save(!policy.is_public, policy.grants)}><span /></button></div>
      <h4>People with access</h4>
      <p className="conn-hint">Instance admins always have access. Select additional members below.</p>
      {!policy.is_public && <><input aria-label="Search people" placeholder="Search people" value={filter} onChange={event=>setFilter(event.target.value)}/><div className="conn-access-users">{users.filter(user => !user.disabled && user.instance_role !== "admin" && `${user.display_name} ${user.username}`.toLowerCase().includes(filter.toLowerCase())).map(user => {
        const checked=policy.grants.includes(user.username);
        return <label key={user.username}><span>{user.display_name || user.username}<small>@{user.username}</small></span>
          <input type="checkbox" checked={checked} disabled={update.isPending}
            onChange={event => save(false,event.target.checked?[...policy.grants,user.username]:policy.grants.filter(x=>x!==user.username))}/></label>;
      })}</div></>}
    </>}
  </div>;
}

function SourceAgentAccess({ source, onBack, onSelect }: { source: AgentSource; onBack: () => void; onSelect: (agent: AgentSource["agents"][number]) => void }) {
  return <div className="conn-access"><BackButton onClick={onBack} label="Connections" />
    <h3>{source.name}</h3><p className="dim">Choose an agent to manage who can start a direct message.</p>
    <div className="conn-access-agent-list">{source.agents.map(agent => <button className="conn-row conn-access-agent" key={agent.id} onClick={()=>onSelect(agent)}>
      <AgentAvatar agentId={agent.id} small /><span className="conn-row-main"><strong>{agent.name}</strong><AgentStatus live={agent.live}/></span><Icon name="chevron-right"/>
    </button>)}</div>
    {!source.agents.length && <p className="dim conn-empty">No agents have registered through this connection yet.</p>}
  </div>;
}

interface AddDefinition {
  kind: ConnectableKind;
  logo?: string;
  title: string;
  shortTitle: string;
  desc: string;
  defaultLabel: string;
  local?: boolean;
  guide?: string;
}

const ADD_DEFINITIONS: AddDefinition[] = [
  {
    kind: "codex", logo: codexLogo, title: "Codex CLI", shortTitle: "Codex",
    desc: "Continue Codex sessions and work on repositories from Agora.",
    defaultLabel: "Codex", local: true,
  },
  {
    kind: "cursor", logo: cursorLogo, title: "Cursor CLI", shortTitle: "Cursor",
    desc: "Run Cursor CLI against projects on your computer.",
    defaultLabel: "Cursor", local: true,
  },
  {
    kind: "claude", logo: claudeLogo, title: "Claude Code", shortTitle: "Claude",
    desc: "Continue Claude Code sessions from any Agora channel.",
    defaultLabel: "Claude", local: true,
  },
  {
    kind: "hermes", logo: hermesLogo, title: "Hermes", shortTitle: "Hermes",
    desc: "Give Hermes secure access to join rooms in this Agora.",
    defaultLabel: "Hermes", guide: "/docs/agents/hermes.html",
  },
  {
    kind: "claw", logo: openClawLogo, title: "OpenClaw", shortTitle: "OpenClaw",
    desc: "Create secure access for an OpenClaw agent.",
    defaultLabel: "OpenClaw", guide: "/docs/agents/openclaw.html",
  },
  {
    kind: "pantheo", logo: pantheoLogo, title: "Pantheo instance", shortTitle: "Pantheo",
    desc: "Link another server and make all of its Agora-enabled agents available.",
    defaultLabel: "",
  },
];

const DEFINITION_BY_KIND = Object.fromEntries(
  ADD_DEFINITIONS.map(definition => [definition.kind, definition]),
) as Record<ConnectableKind, AddDefinition>;

function copyText(text: string, what = "Copied") {
  void (async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast(what, { variant: "ok" });
    } catch {
      toast("Couldn't copy — select the text and copy it manually", { variant: "warn" });
    }
  })();
}

function displayDefinition(token: PairingToken): AddDefinition | null {
  const kind = inferPairingKind(token);
  return kind ? DEFINITION_BY_KIND[kind] : null;
}

function guidePath(definition: AddDefinition): string | null {
  return definition.guide || (definition.local ? `/docs/coding-agents/${definition.kind}.html` : null);
}

function AgentMark({ definition, small = false }: { definition: AddDefinition | null; small?: boolean }) {
  if (definition?.logo) {
    return <img className={`conn-agent-logo${small ? " small" : ""}`} src={definition.logo} alt="" />;
  }
  return (
    <span className={`conn-agent-glyph${small ? " small" : ""}`}>
      <Icon name="bot" />
    </span>
  );
}

function CommandBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="conn-command">
      <code>{text}</code>
      <button className="btn sm" onClick={() => copyText(text, `${label} copied`)}>
        <Icon name="file-text" /> Copy
      </button>
    </div>
  );
}

function AgentCard({ definition, onSelect }: { definition: AddDefinition; onSelect: () => void }) {
  const guide = guidePath(definition);
  return (
    <article className="conn-card">
      <button className="conn-card-select" onClick={onSelect}>
        <div className="conn-card-top">
          <AgentMark definition={definition} />
          {definition.local && <span className="conn-local-badge">Runs on your computer</span>}
        </div>
        <div className="conn-card-title">
          {definition.title}<Icon name="chevron-right" />
        </div>
        <div className="conn-card-desc">{definition.desc}</div>
      </button>
      {guide && (
        <a className="conn-guide-link" href={guide} target="_blank" rel="noopener noreferrer">
          Setup guide <Icon name="external-link" />
        </a>
      )}
    </article>
  );
}

export function ConnectionsPane() {
  const ui = useUiState();
  const closeConnections = useUiState(state => state.openPanel);
  const open = ui.panel === "connections";
  const info = useConnectionsInfo(open, open).data;
  const tokens = usePairingTokens(open, open).data || [];
  const connMut = useConnectionMutations();
  const pairMut = usePairingMutations();
  const sources = useAgentSources(open, open).data || [];
  const [tab, setTab] = useState<Tab>("list");
  const [addKind, setAddKind] = useState<AddKind | null>(null);
  const [issued, setIssued] = useState<{ token: string } | null>(null);
  const [instName, setInstName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [pairName, setPairName] = useState("");
  const [accessSource, setAccessSource] = useState<AgentSource | null>(null);
  const [accessAgent, setAccessAgent] = useState<AgentSource["agents"][number] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const renameInstance = useRenameInstanceLocal();

  useEffect(() => {
    if (!open) {
      setTab("list"); setAddKind(null); setIssued(null);
      setInstName(null); setName(""); setUrl(""); setToken(""); setPairName("");
      setAccessSource(null); setAccessAgent(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeConnections(null);
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(element => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const target = previouslyFocused?.isConnected
        ? previouslyFocused
        : document.querySelector<HTMLElement>("#btn-connections");
      requestAnimationFrame(() => target?.focus());
    };
  }, [open, closeConnections]);

  if (!open) return null;
  const conns = info?.connections || [];
  const instance = info?.instance || null;
  const err = (message: string) => (error: unknown) =>
    toast(`${message}: ${(error as Error).message || error}`, { variant: "warn" });

  const goAdd = (kind?: AddKind) => {
    setAccessSource(null); setAccessAgent(null);
    setAddKind(kind ?? null); setIssued(null); setTab("add");
    setPairName(kind && kind !== "pantheo" && kind !== "coding"
      ? DEFINITION_BY_KIND[kind].defaultLabel
      : "");
  };
  const manageSource = (kind: AgentSource["kind"], id: string) => {
    const source=sources.find(item=>item.kind===kind&&item.id===id);
    if (!source) { toast("Agent roster is still loading", { variant: "warn" }); return; }
    setAccessSource(source);
    if (kind==="pairing" && source.agents.length===1) setAccessAgent(source.agents[0]);
  };

  const listTab = (
    <>
      {instance && (
        <>
          <h4>This Agora <span className="dim">— how linked instances label this app's chats</span></h4>
          <div className="conn-add">
            <input id="inst-name" value={instName ?? (instance.name || "")}
              placeholder="name (e.g. Home Agora)"
              onChange={event => setInstName(event.target.value)} />
            <button className="btn sm primary" onClick={() => {
              const value = (instName ?? instance.name ?? "").trim();
              if (!value) { toast("Name required", { variant: "warn" }); return; }
              renameInstance(value);
              setInstName(null);
            }}>Rename</button>
          </div>
          <p className="conn-hint">Sessions and channel bindings on a linked Pantheo carry this name
            (instance id <code>{(instance.id || "").slice(0, 8)}</code>), so several Agoras stay distinct.</p>
        </>
      )}
      <h4>Pantheo instances <span className="dim">— linked agent servers</span></h4>
      {conns.length ? conns.map(connection => {
        const status = connection.status;
        const agents = (status?.agents || []).map(agent => agent.name || agent.id).join(", ");
        const detail = status?.connected
          ? (agents ? `agents: ${agents}` : "linked, no agents offered")
          : (status?.last_error ? String(status.last_error).slice(0, 120) : "connecting…");
        return (
          <div key={connection.name} className="conn-row">
            <AgentMark definition={DEFINITION_BY_KIND.pantheo} small />
            <span className={`conn-dot ${status?.connected ? "on" : "err"}`} />
            <div className="conn-row-main">
              <div className="conn-name">{connection.name} <span className="conn-badge">Pantheo</span></div>
              <div className="conn-url mono">{connection.url}</div>
              <div className="conn-url">{detail}</div>
            </div>
            <button className="btn sm"
              onClick={() => manageSource("pantheo", connection.name)}>Manage access</button>
            <button className="btn sm"
              onClick={() => connMut.update.mutate(
                { name: connection.name, enabled: !connection.enabled },
                { onError: err("Couldn't update connection") },
              )}>
              {connection.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn sm danger"
              onClick={() => connMut.remove.mutate(connection.name, { onError: err("Remove failed") })}>
              Remove
            </button>
          </div>
        );
      }) : (
        <div className="dim conn-empty">
          None yet. <button className="btn sm" onClick={() => goAdd("pantheo")}>Link a Pantheo</button>
        </div>
      )}
      <h4>Connected agents <span className="dim">— secure access for CLIs and integrations</span></h4>
      {tokens.length ? tokens.map(pairing => {
        const definition = displayDefinition(pairing);
        const liveNames = (pairing.agents || []).map(agent => agent.name || agent.id).join(", ");
        const detail = pairing.connected
          ? (liveNames ? `Live: ${liveNames}` : "Connected, registering…")
          : "Offline";
        return (
          <div key={pairing.token} className="conn-row">
            <AgentMark definition={definition} small />
            <span className={`conn-dot ${pairing.connected ? "on" : "off"}`} />
            <div className="conn-row-main">
              <div className="conn-name">
                {pairing.name}
                <span className="conn-badge">{definition?.shortTitle || "Agent"}</span>
              </div>
              <div className="conn-url mono">{pairing.token.slice(0, 10)}…{pairing.token.slice(-4)}</div>
              <div className="conn-url">{detail}</div>
            </div>
            <button className="btn sm" onClick={() => copyText(pairing.token, "Token copied")}>Copy</button>
            <button className="btn sm" onClick={() => manageSource("pairing", pairing.id)}>Manage access</button>
            <button className="btn sm danger"
              onClick={() => pairMut.revoke.mutate(pairing.token, { onError: err("Revoke failed") })}>
              Revoke
            </button>
          </div>
        );
      }) : (
        <div className="dim conn-empty">
          No agent access created. <button className="btn sm" onClick={() => goAdd()}>Add an agent</button>
        </div>
      )}
    </>
  );

  const addPicker = (
    <div className="conn-catalog">
      <div className="conn-intro">
        <span className="conn-kicker">Bring your agents into the conversation</span>
        <h3>What would you like to connect?</h3>
        <p>Link an agent service or choose a coding agent that runs on your computer.</p>
      </div>
      <div className="conn-cards top-level">
        <AgentCard definition={DEFINITION_BY_KIND.pantheo} onSelect={() => goAdd("pantheo")} />
        <article className="conn-card">
          <button className="conn-card-select" onClick={() => goAdd("coding")}>
            <div className="conn-card-top">
              <span className="conn-logo-stack" aria-hidden>
                <img src={codexLogo} alt="" /><img src={cursorLogo} alt="" /><img src={claudeLogo} alt="" />
              </span>
              <span className="conn-local-badge">Runs on your computer</span>
            </div>
            <div className="conn-card-title">Coding agents <Icon name="chevron-right" /></div>
            <div className="conn-card-desc">Connect Codex CLI, Cursor CLI, or Claude Code.</div>
          </button>
        </article>
        <AgentCard definition={DEFINITION_BY_KIND.hermes} onSelect={() => goAdd("hermes")} />
        <AgentCard definition={DEFINITION_BY_KIND.claw} onSelect={() => goAdd("claw")} />
      </div>
    </div>
  );

  const codingPicker = (
    <>
      <BackButton onClick={() => setAddKind(null)} label="All connection types" />
      <div className="conn-intro conn-coding-intro">
        <span className="conn-kicker">Runs on your computer</span>
        <h3>Choose a coding agent</h3>
        <p>Continue local coding sessions and repository work from Agora.</p>
      </div>
      <div className="conn-cards">
        {(["codex", "cursor", "claude"] as const).map(kind => (
          <AgentCard key={kind} definition={DEFINITION_BY_KIND[kind]} onSelect={() => goAdd(kind)} />
        ))}
      </div>
    </>
  );

  const addPantheo = (
    <>
      <BackButton onClick={() => setAddKind(null)} label="All connection types" />
      <h4>Link a Pantheo instance</h4>
      <div className="conn-form">
        <label>Name
          <input id="conn-name" placeholder="e.g. home" value={name}
            onChange={event => setName(event.target.value)} />
        </label>
        <label>Server address
          <input id="conn-url" placeholder="wss://my-pantheo:8765/agora/connect" value={url}
            onChange={event => setUrl(event.target.value)} />
        </label>
        <label>API token
          <input id="conn-token" placeholder="PANTHEO_API_TOKEN" type="password" value={token}
            onChange={event => setToken(event.target.value)} />
        </label>
        <button className="btn sm primary" onClick={() => {
          if (!name.trim() || !url.trim()) {
            toast("Name and address required", { variant: "warn" }); return;
          }
          connMut.add.mutate({ name: name.trim(), url: url.trim(), token: token.trim() }, {
            onSuccess: () => {
              setName(""); setUrl(""); setToken(""); setTab("list"); setAddKind(null);
              toast("Linked — connecting…", { variant: "ok" });
            },
            onError: err("Link failed"),
          });
        }}>Link</button>
      </div>
      <p className="conn-hint">Use <code>ws://localhost:8765/agora/connect</code> for Pantheo on
        this machine, or its public <code>wss://</code> address for a remote server.</p>
    </>
  );

  const addAgent = (kind: PairingKind) => {
    const definition = DEFINITION_BY_KIND[kind];
    if (issued) {
      const guide = guidePath(definition);
      return (
        <div className="conn-issued">
          <div className="conn-success-mark"><Icon name="check" /></div>
          <h3 className="conn-setup-title">{definition.title} access created</h3>
          <p className="conn-setup-copy">
            {guide
              ? `Copy this token, then follow the complete ${definition.title} guide to configure and start it.`
              : `Use this credential in ${definition.title}'s Agora settings.`}
          </p>
          <CommandBlock text={issued.token} label="Token" />
          {!definition.local && (
            <CommandBlock text={agentWsUrl(window.location.origin, issued.token)} label="Connection address" />
          )}
          <div className="conn-issued-actions">
            {guide && (
              <a className="btn primary conn-guide-cta" href={guide} target="_blank"
                rel="noopener noreferrer">Open setup guide <Icon name="external-link" /></a>
            )}
            <button className={`btn${guide ? "" : " primary"}`}
              onClick={() => { setIssued(null); setAddKind(null); setTab("list"); }}>
              View connections
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <BackButton
          onClick={() => setAddKind(definition.local ? "coding" : null)}
          label={definition.local ? "Coding agents" : "All connection types"}
        />
        <div className="conn-setup-head">
          <AgentMark definition={definition} />
          <div>
            <span className="conn-kicker">{definition.local ? "Coding agent" : "Secure agent access"}</span>
            <h3 className="conn-setup-title">Create access for {definition.title}</h3>
            {guidePath(definition) && (
              <a className="conn-setup-guide" href={guidePath(definition)!} target="_blank"
                rel="noopener noreferrer">Open full setup guide <Icon name="external-link" /></a>
            )}
          </div>
        </div>
        <p className="conn-setup-copy">Choose a friendly name so you can recognize this agent later.</p>
        <div className="conn-form conn-token-form">
          <label>Agent name
            <input id="pair-name" placeholder={definition.defaultLabel} autoFocus value={pairName}
              onChange={event => setPairName(event.target.value)} />
          </label>
          <button className="btn primary" disabled={pairMut.create.isPending} onClick={() => {
            const label = pairName.trim() || definition.defaultLabel;
            pairMut.create.mutate({ name: label, kind }, {
              onSuccess: result => {
                setIssued({ token: result.token });
                setPairName("");
              },
              onError: err("Couldn't create access"),
            });
          }}>{pairMut.create.isPending ? "Creating…" : "Create access"}</button>
        </div>
        {definition.local && (
          <p className="conn-security-note">
            <Icon name="lock" />
            This CLI runs on your computer and can access only what its local configuration allows.
          </p>
        )}
      </>
    );
  };

  return (
    <div className="conn-overlay" id="conn-overlay"
      onClick={event => { if (event.target === event.currentTarget) ui.openPanel(null); }}>
      <div ref={panelRef} className="conn-panel" id="conn-panel" role="dialog" aria-modal="true"
        aria-label="Connections" tabIndex={-1}>
        <div className="conn-head">
          <b>Connections</b>
          <button className="btn sm" aria-label="Close connections"
            onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "list"}
            className={`conn-tab${tab === "list" ? " active" : ""}`}
            onClick={() => { setTab("list"); setAccessSource(null); setAccessAgent(null); }}>Connections</button>
          <button role="tab" aria-selected={tab === "add"}
            className={`conn-tab${tab === "add" ? " active" : ""}`}
            onClick={() => goAdd()}>Add agent</button>
        </div>
        <div className="conn-body">
          {accessAgent ? <AgentAccessPolicy agent={accessAgent} onBack={() => accessSource?.kind==="pairing"&&accessSource.agents.length===1 ? (setAccessAgent(null),setAccessSource(null)) : setAccessAgent(null)} />
            : accessSource ? <SourceAgentAccess source={accessSource} onBack={()=>setAccessSource(null)} onSelect={setAccessAgent}/>
            : tab === "list" ? listTab
            : addKind === null ? addPicker
            : addKind === "coding" ? codingPicker
            : addKind === "pantheo" ? addPantheo
            : addAgent(addKind)}
        </div>
      </div>
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="btn sm conn-back" onClick={onClick}>
      <Icon name="chevron-left" /> {label}
    </button>
  );
}

function useRenameInstanceLocal() {
  const rename = useRenameInstance();
  return (name: string) => rename.mutate(name, {
    onSuccess: () => toast("Renamed — relinking so endpoints pick it up…", { variant: "ok" }),
    onError: error => toast("Rename failed: " + (error as Error).message, { variant: "warn" }),
  });
}
