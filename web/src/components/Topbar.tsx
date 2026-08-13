/* Topbar: brand, server badge, connection-status dot, self-rename button,
   and the operator-only People/Connections buttons. Same ids/classes as
   ui/index.html + shim.js renderServerBadge()/boot(). */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useConnectionsInfo, useMe, useApi, type Me } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { PromptDialog } from "./ThreadRenameDialog";

/* Topbar dot (connRefreshBadge): green when every enabled connection is
   live, amber when some are down, grey when none are configured. The query
   key is shared with the Connections pane, so its 4s poll refreshes this
   too while the pane is open. */
function StatusBadge({ isAdmin }: { isAdmin: boolean }) {
  const info = useConnectionsInfo(false, isAdmin).data;
  if (!isAdmin || !info) return <div className="topbar-status" id="topbar-status"></div>;
  const enabled = (info.connections || []).filter(c => c.enabled);
  const up = enabled.filter(c => c.status && c.status.connected);
  const agents = enabled.reduce((n, c) => n + ((c.status && c.status.agents) || []).length, 0);
  return (
    <div className="topbar-status" id="topbar-status">
      {!enabled.length ? (
        <><span className="conn-dot off"></span> no connections</>
      ) : (
        <>
          <span className={`conn-dot ${up.length === enabled.length ? "on" : up.length ? "part" : "err"}`}></span>
          {" "}{up.length}/{enabled.length} linked · {agents} agent{agents === 1 ? "" : "s"}
        </>
      )}
    </div>
  );
}

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
      <StatusBadge isAdmin={isAdmin} />
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
        <button className="btn sm" id="btn-connections" onClick={() => openPanel("connections")}>Connections</button>
      )}
    </div>
  );
}
