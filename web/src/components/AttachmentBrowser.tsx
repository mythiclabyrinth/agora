import { useEffect, useState } from "react";
import {
  fmtTs, useAttachments, useDeleteAttachment, useGroups,
  type AttachmentBrowserItem,
} from "@agora/core";
import { fileUrl, humanSize } from "../lib/files";
import { toast } from "../lib/toast";
import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";
import { Icon } from "../lib/icons";

export function AttachmentBrowser() {
  const ui = useUiState();
  const groups = useGroups().data || [];
  const channel = groups.flatMap(g => g.channels || []).find(c => c.id === ui.sel.c);
  const threadId = ui.filesThread;
  const q = useAttachments(ui.filesOpen ? (channel?.id || "") : "", threadId);
  const del = useDeleteAttachment(channel?.id || "", threadId);
  const jump = useJump(s => s.request);
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!ui.filesOpen) setArmed(null);
  }, [ui.filesOpen]);
  if (!ui.filesOpen || !channel) {
    return <div className="agora-files-pane" style={{ display: "none" }} />;
  }
  const items = q.data?.pages.flatMap(p => p.items) || [];
  const go = (item: AttachmentBrowserItem) => {
    ui.setFilesOpen(false);
    if (item.thread_id != null) ui.openThread(item.thread_id, "replace");
    else if (ui.sel.g) ui.selectChannel(ui.sel.g, item.channel_id, "replace");
    jump({ mid: item.message_id, container: item.thread_id == null ? "log" : "thread" });
  };
  const remove = (item: AttachmentBrowserItem) => {
    if (armed !== item.id) { setArmed(item.id); return; }
    setArmed(null);
    del.mutate(item.id, {
      onError: e => toast(`Couldn't delete attachment: ${(e as Error).message}`, { variant: "warn" }),
    });
  };
  return (
    <aside className="agora-files-pane" aria-label="Attachments">
      <div className="ago-head">
        <div className="ago-head-text">
          <span className="ago-chan-name">Attachments</span>
          <span className="dim">{threadId == null ? `#${channel.name}` : "this thread"}</span>
        </div>
        <button className="btn sm" title="Close attachments" onClick={() => ui.setFilesOpen(false)}><Icon name="x" /></button>
      </div>
      <div className="ago-files-body">
        {items.map(item => (
          <div className="ago-file-browser-row" key={item.id}>
            <button className="ago-file-browser-main" title="Jump to message" onClick={() => go(item)}>
              <span className="ago-file-browser-icon"><Icon name={item.mime.startsWith("image/") ? "image" : "file-text"} /></span>
              <span className="ago-file-browser-copy">
                <span className="fname">{item.filename}</span>
                <span className="meta">{humanSize(item.size)} · {item.author_name || item.author_id} · {fmtTs(item.ts)}</span>
                {threadId == null && item.thread_name && <span className="ago-thread-file-badge"><Icon name="message-square" /> {item.thread_name}</span>}
              </span>
            </button>
            <a className="ago-x" href={fileUrl(item.id)} download={item.filename} title={`Download ${item.filename}`}><Icon name="download" /></a>
            {item.can_delete && <button className={`ago-x ${armed === item.id ? "armed" : ""}`}
              title={armed === item.id ? "Click again to delete from Agora" : "Delete attachment"}
              onClick={() => remove(item)}><Icon name="trash-2" /></button>}
          </div>
        ))}
        {q.isLoading && <div className="empty">Loading attachments…</div>}
        {q.isError && <div className="empty">Couldn't load attachments.</div>}
        {!q.isLoading && !q.isError && !items.length && <div className="empty">No attachments here yet.</div>}
        {q.hasNextPage && <button className="btn sm ago-files-more" disabled={q.isFetchingNextPage}
          onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "More attachments"}</button>}
      </div>
    </aside>
  );
}
