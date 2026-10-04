import { useAgents } from "@agora/core";
import { Icon } from "../lib/icons";
import { AgentAvatar } from "./AgentAvatar";
import { useAgentProfile } from "./MessageItem";

/** Profiles sit inside the integration that supplies their access controls. */
export function AgentsDirectory({ agents, typeLabel, emptyMessage = "Ready to connect. Agents will appear here when they register." }: {
  agents: { id: string; name: string; live?: boolean }[];
  typeLabel?: string;
  emptyMessage?: string;
}) {
  const roster = useAgents().data || [];
  const showProfile = useAgentProfile(state => state.show);
  if (!agents.length) return <p className="agent-source-pending">{emptyMessage}</p>;
  return <div className="agent-directory-grid">{agents.map(agent => {
    const details = roster.find(item => item.id === agent.id);
    const live = details?.live ?? agent.live ?? false;
    return <button key={agent.id} className="agent-directory-card" onClick={() => showProfile(agent.id)}>
        <AgentAvatar agentId={agent.id} avatar={details?.avatar} />
        <span className="agent-directory-identity">
          {typeLabel && <span className="agent-directory-type">{typeLabel}</span>}
          <strong>{details?.name || agent.name}</strong>
          <small>@{agent.id}</small>
        </span>
        <Icon name="chevron-right" />
        <span className={`agent-directory-status${live ? " online" : ""}`}><i />{live ? "Online" : "Offline"}</span>
        <span className="agent-directory-details">View profile</span>
      </button>;
    })}</div>;
}
