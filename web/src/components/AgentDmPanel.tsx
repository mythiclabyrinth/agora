import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAgentDms, useOpenAgentDm } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { AgentAvatar } from "./AgentAvatar";
import { AgentStatus } from "./AgentStatus";

export function AgentDmPanel({ onClose }: { onClose: () => void }) {
  const data = useAgentDms();
  const openDm = useOpenAgentDm();
  const ui = useUiState();
  const panelRef = useRef<HTMLDivElement>(null);
  /* Sidebar hands us a fresh closure every render; keep the mount-once focus
     effect from cycling (and yanking focus back out) on background updates. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const existing = new Set((data.data?.conversations || []).map(dm => dm.agent_id));
  const agents = (data.data?.agents || []).filter(agent => agent.can_dm && !existing.has(agent.id));
  useEffect(() => {
    const panel = panelRef.current;
    const previous = document.activeElement as HTMLElement | null;
    panel?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(element => !element.hidden);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); requestAnimationFrame(() => previous?.isConnected && previous.focus()); };
  }, []);
  return createPortal(
    <div className="ago-dm-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} className="ago-dm-popover" role="dialog" aria-modal="true"
      aria-label="Start an agent direct message" tabIndex={-1}>
      <div className="ago-dm-popover-head">
        <div><strong>New direct message</strong><span>Choose an agent to message privately</span></div>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <div className="ago-dm-agent-list">
        {agents.map(agent => <button key={agent.id} className="ago-dm-agent"
          disabled={openDm.isPending}
          onClick={() => openDm.mutate(agent.id, { onSuccess: channel => {
            ui.selectChannel("__dms", channel.id); onClose();
          }, onError: e => toast(`Couldn't open DM: ${(e as Error).message}`, { variant: "warn" }) })}>
          <AgentAvatar agentId={agent.id} small /><span className="ago-dm-agent-name">{agent.name}</span><AgentStatus live={agent.live} />
        </button>)}
        {data.isLoading && <div className="dim">Loading agents…</div>}
        {data.isError && <div className="dim">Couldn't load available agents.</div>}
        {data.isSuccess && !agents.length && <div className="dim">No new agents are available to message.</div>}
      </div>
    </div></div>, document.body,
  );
}
