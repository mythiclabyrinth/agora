import type { Member } from "@agora/core";

export type AccessRole = "member" | "admin";
export type AccessDraft = { mode: "group" | "channels"; role: AccessRole; channels: Record<string, AccessRole> };
export type AccessPermissions = { groupAdmin: boolean; channelIds: string[] };
export type AccessChange = { kind: "add" | "remove"; channelId: string | null; role: AccessRole };

export function accessDraft(scopes: Member[]): AccessDraft {
  const whole = scopes.find(scope => !scope.channel_id);
  return { mode: whole ? "group" : "channels", role: whole?.role === "admin" ? "admin" : "member",
    channels: Object.fromEntries(scopes.filter(scope => scope.channel_id).map(scope => [scope.channel_id!, scope.role === "admin" ? "admin" : "member"])) };
}

/** Only emit changes for scopes the caller administers. A route is context,
 * never authority; channel roles from the server determine the editable set. */
export function planAccess(scopes: Member[], draft: AccessDraft, permissions: AccessPermissions): AccessChange[] {
  const original = accessDraft(scopes);
  const allowed = new Set(permissions.channelIds);
  if (draft.mode === "group") {
    if (original.mode === "group" && original.role === draft.role) return [];
    if (!permissions.groupAdmin) throw new Error("Only group admins can change whole-group access.");
    // Adding a user's whole-group row atomically supersedes their channel rows.
    return [{ kind: "add", channelId: null, role: draft.role },
      // Agents keep their narrower rows server-side; clean them up explicitly.
      ...(scopes[0]?.member_type === "agent" ? scopes.filter(scope => scope.channel_id).map(scope => ({ kind: "remove" as const, channelId: scope.channel_id, role: "member" as const })) : [])];
  }
  if (original.mode === "group" && !permissions.groupAdmin) throw new Error("This access is inherited from the group.");
  const changes: AccessChange[] = [];
  if (original.mode === "group") changes.push({ kind: "remove", channelId: null, role: original.role });
  for (const [id, role] of Object.entries(draft.channels)) {
    if (original.mode !== "group" && original.channels[id] === role) continue;
    if (!permissions.groupAdmin && !allowed.has(id)) throw new Error("You can only manage channels you administer.");
    changes.push({ kind: "add", channelId: id, role });
  }
  if (original.mode !== "group" || scopes[0]?.member_type === "agent") {
    for (const [id, role] of Object.entries(original.channels)) {
      if (draft.channels[id]) continue;
      if (!permissions.groupAdmin && !allowed.has(id)) throw new Error("You can only manage channels you administer.");
      changes.push({ kind: "remove", channelId: id, role });
    }
  }
  return changes;
}

/** The API has no atomic replace operation. Keep additions before removals
 * where possible; if narrowing a group fails, try to restore its old grant. */
export async function applyAccess(changes: AccessChange[], apply: (change: AccessChange) => Promise<unknown>) {
  let removedGroup: AccessChange | undefined;
  try {
    for (const change of changes) {
      await apply(change);
      if (change.kind === "remove" && change.channelId === null) removedGroup = change;
    }
  } catch (error) {
    if (removedGroup) {
      try { await apply({ ...removedGroup, kind: "add" }); }
      catch { throw new Error("Access was partly changed and the previous group access could not be restored. Refresh and review this participant's access."); }
      throw new Error("Channel access could not be saved. The previous whole-group access was restored.");
    }
    throw new Error(`Access could not be fully saved. Refresh and review before retrying. ${error instanceof Error ? error.message : ""}`.trim());
  }
}
