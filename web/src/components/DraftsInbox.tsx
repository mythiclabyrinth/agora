import { useEffect, useState } from "react";
import { draftKey, draftSync, fmtRelative, useMessageDrafts, useSyncedDrafts, type DraftRow } from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

export function DraftsInbox() {
  const rows = useSyncedDrafts();
  const loading = useMessageDrafts(s => s.loading);
  const loadError = useMessageDrafts(s => s.loadError);
  const ui = useUiState();
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => { void draftSync.hydrate().catch(() => {}); }, []);
  const open = (row: DraftRow) => {
    ui.selectChannel(row.group_id, row.channel_id);
    if (row.thread_id != null) ui.openThread(row.thread_id);
    requestAnimationFrame(() => document.getElementById(row.thread_id == null ? "ago-msg" : "ago-thread-msg")?.focus());
  };
  return <div className="ago-inbox-content ago-drafts"><div className="ago-log ago-drafts-list">
    {loadError && <div className="empty">Couldn't load drafts. <button className="btn sm" onClick={() => void draftSync.hydrate().catch(() => {})}>Retry</button></div>}
    {rows.map(row => {
      const key = draftKey(row.channel_id, row.thread_id);
      return <div className="ago-unread-card ago-draft-card" key={key}>
        <button className="ago-unread-source" onClick={() => open(row)}>
          {row.thread_id != null ? `↳ ${row.thread_title || "Thread"} in ` : ""}#{row.channel_name} · {row.group_name}
        </button>
        <span className="ago-unread-meta"><time>{fmtRelative(row.updated_at)}</time></span>
        <button className="ago-draft-more" aria-label={`Options for draft in ${row.channel_name}`} onClick={() => setMenu(menu === key ? null : key)}>⋯</button>
        {menu === key && <div className="ago-draft-menu"><button onClick={() => { void draftSync.discard(key).catch(e => toast(`Couldn't discard draft: ${(e as Error).message}`, { variant: "warn" })); setMenu(null); }}>Discard</button></div>}
        <button className="ago-unread-preview" onClick={() => open(row)}>{row.body.replace(/\s+/g, " ").trim().slice(0, 240)}</button>
      </div>;
    })}
    {!rows.length && loading && <div className="empty">Loading drafts…</div>}
    {!rows.length && !loading && !loadError && <div className="empty"><div className="glyph"><Icon name="pencil" /></div><div>No drafts</div></div>}
  </div></div>;
}
