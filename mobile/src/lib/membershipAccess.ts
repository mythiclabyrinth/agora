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

/** Keep inherited whole-group access plus the selected channel in a
 * channel-focused roster. The returned set is also the safe removal set. */
export function visibleMembershipScopes<T extends Pick<Member, "channel_id">>(
  scopes: T[],
  channelId?: string,
) {
  return channelId
    ? scopes.filter(scope => !scope.channel_id || scope.channel_id === channelId)
    : scopes;
}
