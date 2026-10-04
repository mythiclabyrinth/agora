import { useState } from "react";
import { useConnectionsInfo, useRenameInstance } from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";

export function WorkspaceSettings() {
  const query = useConnectionsInfo();
  const rename = useRenameInstance();
  const [name, setName] = useState<string | null>(null);
  const instance = query.data?.instance;
  if (query.isLoading) return <div className="dim conn-empty">Loading workspace…</div>;
  if (query.isError) return <div className="dim conn-empty">Couldn’t load workspace settings. <button className="btn" onClick={() => void query.refetch()}>Retry</button></div>;
  if (!instance) return <div className="dim conn-empty">Workspace identity is unavailable.</div>;
  const value = name ?? instance.name ?? "";
  return <section className="workspace-settings">
    <div className="settings-section-heading"><span className="settings-section-icon"><Icon name="globe" /></span><div>
      <h2>A name for your workspace</h2><p>Help people and linked services recognize this Agora.</p>
    </div></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (!value.trim() || rename.isPending) return;
      rename.mutate(value.trim(), {
        onSuccess: () => { setName(null); toast("Workspace renamed — linked services will pick up the new name.", { variant: "ok" }); },
        onError: error => toast(`Rename failed: ${error.message}`, { variant: "warn" }),
      });
    }}>
      <label htmlFor="inst-name">Workspace name</label>
      <div className="conn-add"><input id="inst-name" value={value} placeholder="e.g. Northwind Labs"
        disabled={rename.isPending} onChange={event => setName(event.target.value)} />
        <button className="btn primary" disabled={!value.trim() || value.trim() === instance.name || rename.isPending}>{rename.isPending ? "Saving…" : "Save name"}</button></div>
      <p className="conn-hint">Linked instances use this name for your chats and channel bindings. Renaming does not change conversations or access.</p>
    </form>
    <div className="workspace-identity"><span>Workspace ID</span><code>{instance.id}</code></div>
  </section>;
}
