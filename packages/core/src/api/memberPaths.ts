export function resolveMemberGroupId(boundGroupId?: string, overrideGroupId?: string) {
  const groupId = overrideGroupId ?? boundGroupId;
  if (!groupId) throw new Error("A group is required for a membership change.");
  return groupId;
}

export function memberRemovalPath(v: {
  groupId: string;
  memberType: string;
  memberId: string;
  channelId?: string | null;
  allScopes?: boolean;
}) {
  const suffix = v.channelId
    ? `?channel_id=${encodeURIComponent(v.channelId)}`
    : v.allScopes ? "?all_scopes=true" : "";
  return `/api/groups/${v.groupId}/members/${v.memberType}/${encodeURIComponent(v.memberId)}${suffix}`;
}
