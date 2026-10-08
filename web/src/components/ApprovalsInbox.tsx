import { fmtRelative, type ApprovalItem, useApprovals } from "@agora/core";
import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";
import { Icon } from "../lib/icons";
import { MessageOptions } from "./MessageOptions";

type Query = ReturnType<typeof useApprovals>;

export function ApprovalsInbox({ query }: { query: Query }) {
  const ui = useUiState();
  const requestJump = useJump(s => s.request);
  const open = (item: ApprovalItem) => {
    ui.selectChannel(item.group_id, item.channel_id);
    if (item.thread_id != null) ui.openThread(item.thread_id);
    requestJump({ mid: item.message.id, container: item.thread_id == null ? "log" : "thread" });
  };
  return <div className="ago-inbox-content ago-approvals">
    <div className="ago-log ago-approvals-list">
      {query.isLoading ? <div className="empty">Loading approvals…</div> : query.isError ?
        <div className="empty">Couldn't load approvals. <button className="btn sm" onClick={() => void query.refetch()}>Retry</button></div> :
        query.data?.map(item => <div className="ago-approval-card" key={`${item.channel_id}:${item.thread_id ?? "channel"}`}>
          <button className="ago-unread-source" onClick={() => open(item)}>
            {item.kind === "thread" ? `↳ ${item.title || "Thread"} in ` : ""}#{item.channel_name} · {item.group_name}
          </button>
          <span className="ago-approval-time">{fmtRelative(item.message.ts)}</span>
          <button className="ago-unread-preview" onClick={() => open(item)}>
            <strong>{item.message.author_name || item.message.author_id}:</strong>{" "}
            {item.message.text.replace(/\s+/g, " ").trim().slice(0, 240) || "Interactive request"}
          </button>
          {item.pending_count > 1 && <span className="ago-unread-badge">+{item.pending_count - 1} more</span>}
          {item.message.meta?.options && <div className="ago-approval-actions" onClick={event => event.stopPropagation()}><MessageOptions message={item.message} /></div>}
        </div>)}
      {!query.isLoading && !query.isError && !query.data?.length &&
        <div className="empty"><div className="glyph"><Icon name="check" /></div><div>No pending approvals</div></div>}
    </div>
  </div>;
}
