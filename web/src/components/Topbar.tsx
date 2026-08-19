/* Topbar: brand, server badge, self-rename button, and the operator-only
   People/Connections buttons. */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useMe, useApi, type Me } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { PromptDialog } from "./PromptDialog";

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
  const isAdmin = !!me?.instance_admin;
  const [renaming, setRenaming] = useState(false);
  const [renamePending, setRenamePending] = useState(false);

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
    <div className="topbar">
      <div className="brand"><span className="brand-mark"><img src="/icon.png" alt="" /></span> Agora</div>
      <ServerBadge />
      <button className="topbar-me" id="topbar-me" title="Change how your name appears"
        onClick={() => setRenaming(true)}>
        {me ? (me.display_name || me.username) : ""}
      </button>
      {renaming && <PromptDialog title="Change display name"
        description="Leave the name blank to use your username."
        label="Display name" value={me?.display_name || me?.username || ""}
        pending={renamePending} onClose={() => setRenaming(false)}
        onSave={value => void rename(value)} />}
      {isAdmin && (
        <button className="btn sm" id="btn-people" onClick={() => openPanel("people")}>People</button>
      )}
      {isAdmin && (
        <button className="btn sm" id="btn-ai" onClick={() => openPanel("ai")}>AI &amp; voice</button>
      )}
      {isAdmin && (
        <button className="btn sm" id="btn-connections" onClick={() => openPanel("connections")}>Connections</button>
      )}
    </div>
  );
}
