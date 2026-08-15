import type { Member } from "@agora/core";

/** A group admin can manage every scope. A channel admin can manage only
 * rows explicitly scoped to the channel they administer. */
export function canManageMembershipScope(
  scope: Pick<Member, "channel_id">,
  groupAdmin: boolean,
  channelId: string | undefined,
  channelAdmin: boolean,
) {
  return groupAdmin || (
    channelAdmin && !!scope.channel_id && scope.channel_id === channelId
  );
}

/** Keep inherited whole-group access plus the selected channel as context in
 * a channel-focused roster. Removal targets must be derived separately. */
export function visibleMembershipScopes<T extends Pick<Member, "channel_id">>(
  scopes: T[],
  channelId?: string,
) {
  return channelId
    ? scopes.filter(scope => !scope.channel_id || scope.channel_id === channelId)
    : scopes;
}

export function hasChannelScope(
  scopes: Array<Pick<Member, "channel_id">>,
  channelId?: string,
) {
  return !!channelId && scopes.some(scope => scope.channel_id === channelId);
}

export function membershipUsernames(
  members: Array<Pick<Member, "member_id" | "channel_id">>,
  channelId?: string,
) {
  return new Set(members.filter(member =>
    !member.channel_id || (!!channelId && member.channel_id === channelId)
  ).map(member => member.member_id));
}

export function personRemovalTargets(
  scopes: Array<Pick<Member, "member_id" | "channel_id">>,
  channelId?: string,
) {
  if (scopes.length === 0) return [];
  if (!channelId) return [{ member_id: scopes[0].member_id, all_scopes: true as const }];
  return scopes.filter(scope => scope.channel_id === channelId).map(scope => ({
    member_id: scope.member_id,
    channel_id: scope.channel_id,
  }));
}
