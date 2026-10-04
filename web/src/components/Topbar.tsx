/* Topbar: brand, server badge, self-rename button, and the operator-only
   People / Connections / Settings buttons. */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useMe, useApi, type Me } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { PromptDialog } from "./PromptDialog";
import { Icon } from "../lib/icons";

function ServerBadge() {
  const host = location.hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  useEffect(() => {
    document.title = local ? "Agora — Local" : "Agora — " + host;
  }, [local, host]);
  return local ? (
    <div className="server-badge" id="server-badge"
      title="This Agora runs on this computer — messages and data are stored here.">
      <span className="srv-dot local"></span>Local server
    </div>
  ) : (
    <div className="server-badge" id="server-badge"
      title={`Connected to ${location.origin} — messages and data live on that server.`}>
      <span className="srv-dot remote"></span>Remote · <b>{host}</b>
    </div>
  );
}

export function Topbar() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe().data;
  const openPanel = useUiState(s => s.openPanel);
  const setSearchOpen = useUiState(s => s.setSearchOpen);
  const isAdmin = !!me?.instance_admin;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const pointer = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setToolsOpen(false);
        toolsRef.current?.querySelector<HTMLButtonElement>(".ago-mobile-tools")?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [toolsOpen]);

  const rename = async (next: string) => {
    setRenamePending(true);
    try {
      const updated = await api.patch<Partial<Me>>("/api/me", { display_name: next });
      qc.setQueryData<Me>(keys.me, prev => prev ? { ...prev, ...updated } : undefined);
      toast("Display name updated", { variant: "ok" });
      setRenaming(false);
    } catch (e) {
      toast("Couldn't update your name: " + ((e as Error).message || e), { variant: "error" });
    } finally {
      setRenamePending(false);
    }
  };

  return (
    <div ref={toolsRef} className={`topbar ${toolsOpen ? "tools-open" : ""}`}>
      <div className="brand"><span className="brand-mark"><img src="/icon.png" alt="" /></span> Agora</div>
      <ServerBadge />
      <button className="workspace-search" aria-label="Search conversations" onClick={() => setSearchOpen(true)}>
        <Icon name="search" /><span>Search conversations</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘ K" : "Ctrl K"}</kbd>
      </button>
      <button className="topbar-me" id="topbar-me" title="Change how your name appears"
        onClick={() => setRenaming(true)}>
        <span className="topbar-avatar" aria-hidden="true">{(me?.display_name || me?.username || "?").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span>
        <span className="topbar-name">{me ? (me.display_name || me.username) : ""}</span>
      </button>
      {renaming && <PromptDialog title="Change display name"
        description="Leave the name blank to use your username."
        label="Display name" value={me?.display_name || me?.username || ""}
        pending={renamePending} onClose={() => setRenaming(false)}
        onSave={value => void rename(value)} />}
      <button className="btn sm ago-mobile-tools" aria-label="Workspace tools" aria-expanded={toolsOpen}
        onClick={() => setToolsOpen(!toolsOpen)}><Icon name="sliders" /></button>
      <div className={`ago-topbar-tools ${toolsOpen ? "open" : ""}`}>
      {isAdmin && (
        <button className="btn sm" id="btn-people" onClick={() => { openPanel("people"); setToolsOpen(false); }}><Icon name="users" />People</button>
      )}
      {isAdmin && (
        <button className="btn sm" id="btn-connections" onClick={() => { openPanel("connections"); setToolsOpen(false); }}><Icon name="bot" />Agents</button>
      )}
        <button className="btn sm" id="btn-settings" onClick={() => { openPanel("settings"); setToolsOpen(false); }}><Icon name="sliders" />Settings</button>
      </div>
    </div>
  );
}
