/* "Resolve all" for one approvals card: the desktop counterpart of the
   phone's swipe. The requests are loaded when the dialog opens and only
   those ids are answered, so one arriving meanwhile stays pending. */

import { useEffect, useRef } from "react";
import {
  APPROVAL_BULK_LABELS, approvalAlwaysScope, approvalBulkResultText, approvalRequestText, approvalBulkSummary, useConversationApprovals, useResolveApprovals,
  type ApprovalBulkAction, type ApprovalItem,
} from "@agora/core";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";

export function ResolveApprovalsDialog({ item, onClose }: { item: ApprovalItem; onClose: () => void }) {
  const pending = useConversationApprovals(item.channel_id, item.thread_id);
  const resolve = useResolveApprovals();
  const ref = useDialogFocus(true, onClose);
  const summary = approvalBulkSummary(pending.data ?? []);
  const count = pending.data?.length ?? 0;
  const title = (item.title || "").replace(/\s+/g, " ").trim();
  const where = item.kind === "thread" ? `${title || "Thread"} in #${item.channel_name}` : `#${item.channel_name}`;
  // One request at a time (isPending lags a render behind a double click),
  // and a result that lands after this dialog closed only reports: it must
  // not close a dialog opened since for another card.
  const busy = useRef(false);
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  const choose = (action: ApprovalBulkAction) => {
    const ids = summary.ids[action];
    if (!ids.length || busy.current) return;
    busy.current = true;
    // The promise settles even if the dialog was closed meanwhile (per-call
    // mutate callbacks would not), so the outcome is always reported.
    resolve.mutateAsync({ channelId: item.channel_id, threadId: item.thread_id, ids, action }).then(result => {
      toast(approvalBulkResultText(result), result.failed ? { variant: "warn" } : {});
      if (open.current) onClose();
    }, error => {
      busy.current = false;
      toast(`Resolve all failed: ${(error as Error).message}`, { variant: "warn" });
    });
  };
  const detail = (action: ApprovalBulkAction) => {
    const n = summary.ids[action].length;
    if (!n) return "None of these offer it";
    const requests = `${n} ${n === 1 ? "request" : "requests"}`;
    const scope = approvalAlwaysScope(summary);
    return action === "always" && scope ? `${requests} · stops asking about ${scope} for this agent session` : requests;
  };
  return <div className="conn-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} className="conn-panel ago-resolve-panel" role="dialog" aria-modal="true" aria-label="Resolve all" tabIndex={-1}>
      <div className="conn-head"><b>Resolve all</b><button className="btn sm" aria-label="Close resolve all" onClick={onClose}><Icon name="x" /></button></div>
      <div className="conn-body">
        <p className="dim ago-resolve-where">{where}</p>
        {pending.isLoading ? <p className="dim">Loading requests…</p>
          : pending.isError ? <p>Couldn't load the requests. <button className="btn sm" onClick={() => void pending.refetch()}>Retry</button></p>
          : <>
            <p className="ago-resolve-lead">{count === 1 ? "1 pending request" : `${count} pending requests`}{summary.manual
              ? ` · ${summary.manual} ${summary.manual === 1 ? "needs" : "need"} answering one by one` : ""}</p>
            {/* Every request the choice answers, by name (scrolls when long):
                never approve unseen requests. */}
            <ul className="ago-resolve-list">
              {(pending.data ?? []).map(request =>
                <li key={request.id}><b>{request.author_name}:</b> {approvalRequestText(request.text)}</li>)}
            </ul>
            <div className="ago-resolve-choices">
              {(["approve", "always", "reject"] as const).map(action =>
                <button key={action} className={`ago-resolve-choice ${action}`} disabled={!summary.ids[action].length || resolve.isPending}
                  onClick={() => choose(action)}>
                  <b>{APPROVAL_BULK_LABELS[action]}</b><span>{detail(action)}</span>
                </button>)}
            </div>
          </>}
      </div>
    </div>
  </div>;
}
