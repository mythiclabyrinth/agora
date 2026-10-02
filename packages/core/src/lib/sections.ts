/* Shared conversational-section derivation for navigation rails. Keeping
   the boundary and label rules here prevents web and native from drifting. */

import type { AgentInfo, Message } from "../api/types";

export interface ConversationSection {
  mid: number;
  label: string;
  agentId?: string;
}

// Distinct hues that stay legible as small outlined dots on light and dark surfaces.
const RAIL_AGENT_COLORS = [
  "#d97a36", "#448edb", "#b365d6",
  "#d25585", "#c9a227", "#5aa64a",
] as const;

function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/** Resolve colours against the full roster, independent of message order. */
export function agentRailColors(agents: Pick<AgentInfo, "id" | "rail_marker">[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<number>();
  for (const id of [...new Set(agents.filter(a => a.rail_marker).map(a => a.id))].sort()) {
    let slot = hashId(id) % RAIL_AGENT_COLORS.length;
    if (used.size < RAIL_AGENT_COLORS.length) {
      while (used.has(slot)) slot = (slot + 1) % RAIL_AGENT_COLORS.length;
      used.add(slot);
    }
    colors.set(id, RAIL_AGENT_COLORS[slot]);
  }
  return colors;
}

function firstLine(text: string, max = 64): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  return compact.length > max
    ? `${compact.slice(0, max - 1).trimEnd()}…`
    : compact;
}

/** A section starts at the first message, each human post, and each marked agent post. */
export function conversationSections(
  messages: Message[],
  agentColors: ReadonlyMap<string, string> = new Map(),
): ConversationSection[] {
  const sections: ConversationSection[] = [];
  for (const message of messages) {
    const markedAgent = message.author_type === "agent" && agentColors.has(message.author_id);
    if (sections.length === 0 || message.author_type === "user" || markedAgent) {
      const who = message.author_name || message.author_id;
      const body = firstLine(message.text);
      sections.push({ mid: message.id, label: body ? `${who}: ${body}` : who,
        ...(markedAgent ? { agentId: message.author_id } : {}) });
    }
  }
  return sections;
}
