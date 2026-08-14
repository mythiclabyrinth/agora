/* Query-key factory. Thread pages are keyed by root id (0 = top level) so
   the WS reducer can address exactly the list a new message belongs to. */

export const keys = {
  me: ["me"] as const,
  groups: ["groups"] as const,
  messages: (channelId: string, threadId: number | null) =>
    ["messages", channelId, threadId ?? 0] as const,
  message: (id: number) => ["message", id] as const,
  threads: ["threads"] as const,
  pins: (channelId: string) => ["pins", channelId] as const,
  stars: (channelId: string) => ["stars", channelId] as const,
  attachments: (channelId: string, threadId: number | null) =>
    ["attachments", channelId, threadId ?? 0] as const,
  channelAgents: (channelId: string) => ["channelAgents", channelId] as const,
  activity: (channelId: string) => ["activity", channelId] as const,
  members: (groupId: string) => ["members", groupId] as const,
  memberships: ["memberships"] as const,
  templates: (groupId: string) => ["templates", groupId] as const,
  users: ["users"] as const,
  agents: ["agents"] as const,
  dms: ["dms"] as const,
  agentDmPolicy: (agentId: string) => ["agentDmPolicy", agentId] as const,
  search: (q: string, scope: string, file = "") => ["search", q, scope, file] as const,
  connections: ["connections"] as const,
  connectionsInfo: ["connectionsInfo"] as const,
  pairing: ["pairing"] as const,
  agentSources: ["agent-sources"] as const,
  invites: ["invites"] as const,
};
