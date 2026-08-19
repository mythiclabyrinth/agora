/* Threads inbox (.ago-inbox-list): every thread the user participates in,
   newest first, with rename and two-step remove on each row. */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fmtTs, keys, useGroups, useHideThread, useMe, useRenameThread, useThreads,
  type ThreadRow,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { useUiState } from "../state/ui";
import { PromptDialog } from "./PromptDialog";

function snippet(m: { alias?: string | null; text?: string }): string {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

function InboxRow({ t }: { t: ThreadRow }) {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const hide = useHideThread();
  const rename = useRenameThread();
  const armed = useConfirm(s => s.armed) === `thr:${t.root.id}`;
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const g = groups.find(x => x.id === t.group_id);
  const canRemove = (g && g.role === "admin") || !!me?.instance_admin;
  const root = t.root || ({} as ThreadRow["root"]);
  const [renaming, setRenaming] = useState(false);

  return (
    <div className={`ago-inbox-row ${t.unread ? "unread" : ""}`}
      onClick={() => {
        ui.selectChannel(t.group_id, t.channel_id);
        ui.openThread(root.id, "replace");
      }}>
      <div className="ago-inbox-top">
        <span className="chan"><span className="hash">#</span>{t.channel_name}<span className="grp"> · {t.group_name}</span></span>
        <div className="ago-inbox-meta">
          <span className="ts">{fmtTs(t.last_reply_ts || root.ts)}</span>
          <span className="ago-inbox-actions">
            <button className="ago-x" title="Rename this thread"
              onClick={e => {
                e.stopPropagation();
                setRenaming(true);
              }}>
              <Icon name="pencil" />
            </button>
            {renaming && <PromptDialog title="Rename thread"
              description="Leave the name blank to use the first line of the thread."
              label="Thread name" value={root.alias || ""} pending={rename.isPending}
              onClose={() => setRenaming(false)} onSave={alias => rename.mutate(
                { threadId: root.id, alias },
                {
                  onSuccess: () => setRenaming(false),
                  onError: error => toast(`Couldn't rename thread: ${(error as Error).message}`, { variant: "warn" }),
                },
              )} />}
            {canRemove && (
              <button className={`ago-x ${armed ? "armed" : ""}`}
                title={armed ? "Click again to remove this thread" : "Remove from Threads (messages stay in the channel; posting again restores it)"}
                onClick={e => {
                  e.stopPropagation();
                  if (!armed) { arm(`thr:${root.id}`); return; }
                  disarm();
                  hide.mutate(root.id);
                }}>
                {armed ? "Sure?" : <Icon name="x" />}
              </button>
            )}
          </span>
        </div>
      </div>
      <div className="ago-inbox-main">
        <span className="author">{root.author_name || root.author_id}</span>
        <span className="snippet">{snippet(root)}</span>
      </div>
      <div className="ago-inbox-foot">
        <span className="replies">{t.reply_count} repl{t.reply_count === 1 ? "y" : "ies"}</span>
        {(t.unread || 0) > 0 && <span className="ago-unread-badge">{t.unread > 99 ? "99+" : t.unread}</span>}
      </div>
    </div>
  );
}

export function ThreadsInbox() {
  const ui = useUiState();
  const qc = useQueryClient();
  const threads = useThreads().data || [];

  return (
    <div className="agora-main" id="agora-main">
      <div className="ago-head">
        <button className="btn sm ago-back" title="Back to groups" onClick={() => ui.backToGroups()}>
          <Icon name="chevron-left" />
        </button>
        <div className="ago-head-text">
          <span className="ago-chan-name"><Icon name="messages-square" /> Threads</span>
          <span className="dim">conversations you're part of</span>
        </div>
        <div className="ago-head-actions">
          <button className="btn sm" title="Refresh"
            onClick={() => void qc.invalidateQueries({ queryKey: keys.threads })}>
            <Icon name="refresh-cw" />
          </button>
        </div>
      </div>
      <div className="ago-log ago-inbox-list">
        {threads.length
          ? threads.map(t => <InboxRow key={t.root.id} t={t} />)
          : (
            <div className="empty">
              <div className="glyph"><Icon name="messages-square" /></div>
              <div>No threads yet</div>
              <div className="hint">Threads you start or reply in show up here, with unread counts as replies land.</div>
            </div>
          )}
      </div>
    </div>
  );
}
