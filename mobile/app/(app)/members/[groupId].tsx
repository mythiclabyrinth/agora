/* Group members, mirroring the desktop members pane: people and agents in
   sections, channel-scope shown by name, live/offline status, an add-agent
   flow with a "whole group / one channel" scope picker, and (for group
   admins) an add-person flow with a member/admin role picker plus
   promote/demote. Anyone can leave a group themselves. */

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, User, X } from "lucide-react-native";
import {
  useAddMember,
  useAgents,
  useGroups,
  useMembers,
  useRemoveMember,
  useUsers,
} from "@agora/core";
import type { AgentInfo, Member, UserInfo } from "@agora/core";
import { AgentAvatar } from "../../../src/components/AgentAvatar";
import { ArmedButton } from "../../../src/components/ArmedButton";
import { Icon } from "../../../src/components/Icon";
import { toast, toastErr } from "../../../src/components/Toast";
import { colors } from "../../../src/lib/theme";
import { useSession } from "../../../src/state/session";
import { canManageMembershipScope, personRemovalTargets, visibleMembershipScopes } from "../../../src/lib/membershipAccess";
import { RoleDropdown } from "../../../src/components/RoleDropdown";

function LiveDot({ live }: { live: boolean }) {
  return <View style={[styles.dot, { backgroundColor: live ? colors.green : colors.faint }]} />;
}

function PersonMemberRow({
  name, scopes, channelName, isSelf, canManageScope, onRemoveScope, onSetRole, onRemoveAll, removeAllLabel,
}: {
  name: string;
  scopes: Member[];
  channelName: (id: string | null) => string | null;
  isSelf: boolean;
  canManageScope: (m: Member) => boolean;
  onRemoveScope: (m: Member) => void;
  onSetRole: (m: Member, role: "admin" | "member") => void;
  onRemoveAll?: () => void;
  removeAllLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.personCard}>
    <Pressable style={styles.personHeader} onPress={() => setExpanded(value => !value)} accessibilityRole="button">
      <Icon icon={User} size={20} />
      <View style={styles.personIdentity}>
          <Text style={styles.name}>{name}{isSelf ? <Text style={styles.meta}> (you)</Text> : null}</Text>
          <Text style={styles.meta}>{scopes.length} {scopes.length === 1 ? "access level" : "access levels"}</Text>
      </View>
      <Icon icon={expanded ? ChevronUp : ChevronDown} size={17} color={colors.faint} />
    </Pressable>
    {expanded ? <>
      <View style={styles.scopeList}>
        {scopes.map(scope => {
          const manageable = canManageScope(scope);
          const shadowed = !!scope.channel_id && scopes.some(candidate => !candidate.channel_id);
          return <View key={scope.channel_id ?? "group"} style={styles.scopeRow}>
            <View style={styles.scopeInfo}>
              <Text style={styles.scopeName} numberOfLines={1} ellipsizeMode="tail">{scope.channel_id ? `# ${channelName(scope.channel_id)}` : "Whole group"}</Text>
              {!manageable && scope.channel_id === null ? <Text style={styles.meta}>Managed by a group admin</Text> : null}
            </View>
            <View style={styles.scopeActions}>
              {manageable && !shadowed ? <>
              <RoleDropdown value={scope.role === "admin" ? "admin" : "member"} onChange={role => onSetRole(scope, role)} />
              <Pressable style={styles.iconAction} hitSlop={8} onPress={() => onRemoveScope(scope)} accessibilityLabel={`Remove ${name} from this scope`}>
                <Icon icon={X} size={12} color={colors.dim} />
              </Pressable>
              </> : <View><Text style={styles.roleLabel}>{scope.role}</Text>{shadowed ? <Text style={styles.meta}>Included in whole-group access</Text> : null}</View>}
            </View>
          </View>;
        })}
      </View>
      {onRemoveAll ? <View style={styles.personFooter}><ArmedButton label={removeAllLabel ?? (isSelf ? "Leave" : "Remove all")} onConfirm={onRemoveAll} /></View> : null}
    </> : null}
  </View>;
}

/* One row per agent: an agent scoped to several channels comes back as
   several membership rows, so they arrive collapsed here with every scope
   rendered as a tag. Admins can drop one scope from its tag, or remove the
   agent from every scope at once. */
function AgentMemberRow({
  memberId,
  name,
  scopes,
  channelName,
  offline,
  admin,
  onRemoveScope,
  onRemoveAll,
  canManageScope,
}: {
  memberId: string;
  name: string;
  scopes: Member[];
  channelName: (id: string | null) => string | null;
  offline: boolean;
  admin: boolean;
  onRemoveScope: (m: Member) => void;
  onRemoveAll: () => void;
  canManageScope: (m: Member) => boolean;
}) {
  return (
    <View style={styles.agentCard}>
      <View style={styles.agentHeader}>
        <AgentAvatar agentId={memberId} size={26} />
        <View style={styles.agentIdentity}>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.meta}>
            member
            {offline ? <Text style={styles.offline}> · offline — won't reply</Text> : null}
          </Text>
        </View>
      </View>
      <View style={styles.tagRow}>
          {scopes.map((s) => (
            <View key={s.channel_id ?? "group"} style={styles.tag}>
              <Text style={styles.tagText} numberOfLines={1} ellipsizeMode="tail">
                {s.channel_id ? `# ${channelName(s.channel_id)}` : "Whole group"}
              </Text>
              {canManageScope(s) ? (
                <Pressable hitSlop={8} onPress={() => onRemoveScope(s)}>
                  <Icon icon={X} size={12} color={colors.dim} />
                </Pressable>
              ) : null}
            </View>
          ))}
      </View>
      {admin && scopes.every(canManageScope) ? <View style={styles.agentFooter}><ArmedButton label="Remove" onConfirm={onRemoveAll} /></View> : null}
    </View>
  );
}

/* Two-step add flow: pick an agent, then pick its scope. */
function AddAgent({
  agents,
  channels,
  pending,
  onAdd,
  onCancel,
  allowWholeGroup = true,
}: {
  agents: AgentInfo[];
  channels: { id: string; name: string }[];
  pending: boolean;
  onAdd: (agent: AgentInfo, channelId: string | null) => void;
  onCancel: () => void;
  allowWholeGroup?: boolean;
}) {
  const [picked, setPicked] = useState<AgentInfo | null>(null);

  if (!picked) {
    return (
      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Pick an agent</Text>
        {agents.map((a) => (
          <Pressable key={a.id} style={styles.row} onPress={() => setPicked(a)}>
            <AgentAvatar agentId={a.id} size={26} />
            <LiveDot live={a.live} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{a.name}</Text>
              <Text style={styles.meta}>{a.live ? "online" : "offline"}</Text>
            </View>
            <Icon icon={ChevronRight} size={17} color={colors.faint} />
          </Pressable>
        ))}
        {agents.length === 0 ? (
          <Text style={styles.hint}>
            No agents yet. Link a Pantheo instance or pair a bridge under{" "}
            <Link href="/(app)/agents" style={styles.hintLink}>
              Agents
            </Link>{" "}
            first.
          </Text>
        ) : null}
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.addBox}>
      <Text style={styles.addTitle}>
        Where should <Text style={styles.name}>{picked.name}</Text> listen?
      </Text>
      <Text style={styles.hint}>Scope it to one channel, or give it the whole group.</Text>
      <View style={styles.scopeChips}>
        {allowWholeGroup ? <Pressable
          style={styles.scopeChip}
          disabled={pending}
          onPress={() => onAdd(picked, null)}
        >
          <Text style={styles.scopeText}>Whole group</Text>
        </Pressable> : null}
        {channels.map((c) => (
          <Pressable
            key={c.id}
            style={styles.scopeChip}
            disabled={pending}
            onPress={() => onAdd(picked, c.id)}
          >
            <Text style={styles.scopeText}># {c.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={styles.cancelBtn} onPress={() => setPicked(null)}>
        <View style={styles.cancelRow}>
          <Icon icon={ChevronLeft} size={15} />
          <Text style={styles.cancelText}>Back</Text>
        </View>
      </Pressable>
    </View>
  );
}

/* Two-step add flow: pick a workspace user, then a role. */
function AddPerson({
  users,
  channels,
  pending,
  onAdd,
  onCancel,
  allowWholeGroup = true,
}: {
  users: UserInfo[];
  channels: { id: string; name: string }[];
  pending: boolean;
  onAdd: (user: UserInfo, role: "admin" | "member", channelId: string | null) => void;
  onCancel: () => void;
  allowWholeGroup?: boolean;
}) {
  const [picked, setPicked] = useState<UserInfo | null>(null);
  const [pickedScope, setPickedScope] = useState<{ id: string | null; name: string } | null>(null);

  if (!picked) {
    return (
      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Pick a person</Text>
        {users.map((u) => (
          <Pressable key={u.username} style={styles.row} onPress={() => setPicked(u)}>
            <Icon icon={User} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{u.display_name || u.username}</Text>
              <Text style={styles.meta}>{u.username}</Text>
            </View>
            <Icon icon={ChevronRight} size={17} color={colors.faint} />
          </Pressable>
        ))}
        {users.length === 0 ? (
          <Text style={styles.hint}>
            Everyone in the workspace is already in this group. Instance admins can
            invite new people from the web app.
          </Text>
        ) : null}
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const scopes = [
    ...(allowWholeGroup ? [{ id: null, name: "Whole group" }] : []),
    ...channels,
  ] as { id: string | null; name: string }[];

  if (!pickedScope) {
    return <View style={styles.addBox}>
      <Text style={styles.addTitle}>Where should {picked.display_name || picked.username} have access?</Text>
      <Text style={styles.hint}>Choose one scope. You can add another afterward.</Text>
      <View style={styles.optionList}>{scopes.map(scope =>
        <Pressable key={scope.id ?? "group"} style={styles.optionRow} onPress={() => setPickedScope(scope)}>
          <Text style={styles.scopeName}>{scope.id ? `# ${scope.name}` : scope.name}</Text>
          <Icon icon={ChevronRight} size={17} color={colors.faint} />
        </Pressable>
      )}</View>
      <Pressable style={styles.cancelBtn} onPress={() => setPicked(null)}><Text style={styles.cancelText}>‹ Back</Text></Pressable>
    </View>;
  }

  return (
    <View style={styles.addBox}>
      <Text style={styles.addTitle}>Choose a role for {pickedScope.id ? `# ${pickedScope.name}` : pickedScope.name}</Text>
      <View style={styles.roleOptions}>
        <Pressable style={styles.roleOption} disabled={pending} onPress={() => onAdd(picked, "member", pickedScope.id)}>
          <Text style={styles.scopeName}>Member</Text><Text style={styles.meta}>Can read and participate</Text>
        </Pressable>
        <Pressable style={styles.roleOption} disabled={pending} onPress={() => onAdd(picked, "admin", pickedScope.id)}>
          <Text style={styles.scopeName}>Admin</Text><Text style={styles.meta}>Can also manage this access</Text>
        </Pressable>
      </View>
      <Pressable style={styles.cancelBtn} onPress={() => setPickedScope(null)}>
        <View style={styles.cancelRow}>
          <Icon icon={ChevronLeft} size={15} />
          <Text style={styles.cancelText}>Back</Text>
        </View>
      </Pressable>
    </View>
  );
}

export default function MembersScreen() {
  const params = useLocalSearchParams<{ groupId: string; name?: string; channelId?: string }>();
  const groupId = params.groupId;
  const members = useMembers(groupId);
  const agents = useAgents();
  const groups = useGroups();
  const addMember = useAddMember(groupId);
  const removeMember = useRemoveMember(groupId);
  const [adding, setAdding] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const username = useSession((s) => s.username);

  const group = useMemo(
    () => (groups.data ?? []).find((g) => g.id === groupId) ?? null,
    [groups.data, groupId],
  );
  const groupAdmin = group ? group.role === "admin" : true;
  const selectedChannel = group?.channels.find(channel => channel.id === params.channelId);
  const admin = groupAdmin || selectedChannel?.role === "admin";
  // Only fetch the workspace roster when the picker can actually be used.
  const users = useUsers(admin);
  const channels = group?.channels ?? [];
  const channelName = (id: string | null) =>
    id ? (channels.find((c) => c.id === id)?.name ?? id) : null;
  const liveById = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a.live])),
    [agents.data],
  );

  const people = (members.data ?? []).filter((m) => m.member_type === "user");
  const agentMembers = (members.data ?? []).filter((m) => m.member_type === "agent");

  /* Collapse an agent's per-channel membership rows into one entry. */
  const agentGroups = useMemo(() => {
    const byId = new Map<string, Member[]>();
    for (const m of (members.data ?? []).filter((x) => x.member_type === "agent")) {
      const list = byId.get(m.member_id);
      if (list) list.push(m);
      else byId.set(m.member_id, [m]);
    }
    return [...byId.entries()].map(([id, scopes]) => ({ id, scopes }));
  }, [members.data]);
  const peopleGroups = useMemo(() => {
    const byId = new Map<string, Member[]>();
    for (const member of (members.data ?? []).filter(item => item.member_type === "user")) {
      const scopes = byId.get(member.member_id) ?? [];
      scopes.push(member);
      byId.set(member.member_id, scopes);
    }
    return [...byId.entries()].map(([id, scopes]) => ({ id, scopes }));
  }, [members.data]);
  const visiblePeopleGroups = useMemo(() => peopleGroups.map(person => ({
    ...person,
    scopes: visibleMembershipScopes(person.scopes, params.channelId),
  })).filter(person => person.scopes.length > 0), [params.channelId, peopleGroups]);
  const visibleAgentGroups = useMemo(() => agentGroups.map(agent => ({
    ...agent,
    scopes: visibleMembershipScopes(agent.scopes, params.channelId),
  })).filter(agent => agent.scopes.length > 0), [agentGroups, params.channelId]);

  /* Desktop lists every known agent in the picker (an agent can be scoped to
     several channels); only hide the ones that already listen group-wide. */
  const groupWide = new Set(
    agentMembers.filter((m) => !m.channel_id).map((m) => m.member_id),
  );
  const addable = (agents.data ?? []).filter((a) => !groupWide.has(a.id));

  const memberUsernames = new Set(people.filter(m =>
    !m.channel_id || (!!params.channelId && m.channel_id === params.channelId)
  ).map((m) => m.member_id));
  const addablePeople = (users.data ?? []).filter(
    (u) => !u.disabled && !memberUsernames.has(u.username),
  );

  const addPerson = (u: UserInfo, role: "admin" | "member", channelId: string | null) => {
    addMember.mutate(
      { member_type: "user", member_id: u.username, role, channel_id: channelId ?? undefined },
      {
        onSuccess: () => {
          setAddingPerson(false);
          toast(`${u.display_name || u.username} added to the group.`);
        },
        onError: (e) => toastErr("Add failed", e),
      },
    );
  };

  // Re-adding with a new role upserts it server-side — that's promote/demote.
  const setRole = (m: Member, role: "admin" | "member") => {
    addMember.mutate(
      { member_type: "user", member_id: m.member_id, role, channel_id: m.channel_id ?? undefined },
      { onError: (e) => toastErr("Role change failed", e) },
    );
  };

  const add = (agent: AgentInfo, channelId: string | null) => {
    addMember.mutate(
      { member_type: "agent", member_id: agent.id, channel_id: channelId ?? undefined },
      {
        onSuccess: () => {
          setAdding(false);
          if (agent.live) {
            toast(`${agent.name} added — it will answer messages here.`);
          } else {
            toast(
              `${agent.name} joined, but it's offline right now — it will answer once its connection is live.`,
              "warn",
            );
          }
        },
        onError: (e) => toastErr("Add failed", e),
      },
    );
  };

  const remove = (m: Member) =>
    removeMember.mutate(
      { member_type: m.member_type, member_id: m.member_id, channel_id: m.channel_id },
      { onError: (e) => toastErr("Remove failed", e) },
    );

  const removePersonScopes = async (scopes: Member[]) => {
    try {
      for (const target of personRemovalTargets(scopes, params.channelId)) await removeMember.mutateAsync({
        member_type: "user", ...target,
      });
    } catch (e) { toastErr("Remove failed", e); }
  };

  /* The API deletes one (member, channel) pair per call, so removing an
     agent entirely means one DELETE per scope. */
  const removeAgentEverywhere = async (scopes: Member[]) => {
    try {
      for (const m of scopes) {
        await removeMember.mutateAsync({
          member_type: "agent",
          member_id: m.member_id,
          channel_id: m.channel_id,
        });
      }
    } catch (e) {
      toastErr("Remove failed", e);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: selectedChannel
            ? `${selectedChannel.name} · members`
            : params.name || group?.name ? `${params.name || group?.name} · members` : "Members",
          headerShown: true,
        }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {visiblePeopleGroups.length > 0 ? <Text style={styles.section}>People</Text> : null}
        {visiblePeopleGroups.map(person => {
          const isSelf = person.id === username;
          const hasSelectedChannelScope = !params.channelId
            || person.scopes.some(scope => scope.channel_id === params.channelId);
          const canManageScope = (scope: Member) => canManageMembershipScope(scope, groupAdmin, params.channelId, !!admin);
          return <PersonMemberRow
            key={`user:${person.id}`}
            name={person.scopes[0].name || person.id}
            scopes={person.scopes}
            channelName={channelName}
            isSelf={isSelf}
            canManageScope={canManageScope}
            onRemoveScope={remove}
            onSetRole={setRole}
            onRemoveAll={(groupAdmin || isSelf) && hasSelectedChannelScope ? () => void removePersonScopes(person.scopes) : undefined}
            removeAllLabel={params.channelId
              ? `${isSelf ? "Leave" : "Remove from"} #${selectedChannel?.name ?? channelName(params.channelId)}`
              : undefined}
          />;
        })}
        {admin && !addingPerson ? (
          <Pressable style={styles.addBtn} onPress={() => setAddingPerson(true)}>
            <Text style={styles.addBtnText}>＋ Add person</Text>
          </Pressable>
        ) : null}
        {admin && addingPerson ? (
          <AddPerson
            users={addablePeople}
            channels={groupAdmin ? channels : channels.filter(channel => channel.id === params.channelId)}
            pending={addMember.isPending}
            onAdd={addPerson}
            onCancel={() => setAddingPerson(false)}
            allowWholeGroup={groupAdmin}
          />
        ) : null}

        {visibleAgentGroups.length > 0 ? <Text style={styles.section}>Agents</Text> : null}
        {visibleAgentGroups.map((g) => (
          <AgentMemberRow
            key={`agent:${g.id}`}
            memberId={g.id}
            name={g.scopes[0].name || g.id}
            scopes={g.scopes}
            channelName={channelName}
            offline={liveById.get(g.id) === false}
            admin={admin}
            onRemoveScope={remove}
            onRemoveAll={() => void removeAgentEverywhere(g.scopes)}
            canManageScope={(scope) => canManageMembershipScope(scope, groupAdmin, params.channelId, !!admin)}
          />
        ))}
        {members.isSuccess && agentMembers.length === 0 ? (
          <Text style={styles.empty}>No agents in this group yet.</Text>
        ) : null}

        {admin && !adding ? (
          <Pressable style={styles.addBtn} onPress={() => setAdding(true)}>
            <Text style={styles.addBtnText}>＋ Add agent</Text>
          </Pressable>
        ) : null}
        {admin && adding ? (
          <AddAgent
            agents={addable}
            channels={groupAdmin ? channels : channels.filter(channel => channel.id === params.channelId)}
            pending={addMember.isPending}
            onAdd={add}
            onCancel={() => setAdding(false)}
            allowWholeGroup={groupAdmin}
          />
        ) : null}
        {admin ? (
          <Text style={styles.hint}>
            Agents answer messages in the channels they listen to. Connect agents on the{" "}
            <Link href="/(app)/agents" style={styles.hintLink}>
              Agents
            </Link>{" "}
            page first.
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 8, paddingBottom: 40 },
  section: {
    color: colors.dim,
    fontSize: 11.5,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  name: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  meta: { color: colors.dim, fontSize: 12 },
  offline: { color: colors.amber },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 14 },
  addBtn: { alignItems: "center", paddingVertical: 12 },
  addBtnText: { color: colors.a1, fontSize: 14.5, fontWeight: "700" },
  addBox: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 12,
    gap: 8,
    marginTop: 6,
  },
  addTitle: { color: colors.text, fontSize: 14.5, fontWeight: "700" },
  scopeChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  scopeChip: {
    backgroundColor: "rgba(139,124,255,0.15)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.3)",
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  scopeText: { color: colors.a1, fontSize: 13.5, fontWeight: "600" },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    flexShrink: 1,
    gap: 4,
    backgroundColor: "rgba(139,124,255,0.12)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.25)",
    borderRadius: 7,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  tagText: { color: colors.a1, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  agentCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8 },
  agentHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  agentIdentity: { flex: 1, flexShrink: 1 },
  agentFooter: { alignItems: "flex-end", paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border },
  personCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8 },
  personHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  personIdentity: { flex: 1, flexShrink: 1 },
  scopeList: { gap: 7, marginTop: 5 },
  scopeRow: { gap: 7, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  scopeInfo: { flexShrink: 1 },
  scopeActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 },
  scopeName: { color: colors.text, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  roleLabel: { color: colors.a1, fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  iconAction: { padding: 7 },
  personFooter: { alignItems: "flex-end", paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border },
  optionList: { gap: 6 },
  optionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 },
  roleOptions: { gap: 8 },
  roleOption: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10, padding: 12, gap: 2 },
  cancelBtn: { alignItems: "center", paddingVertical: 8 },
  cancelRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  cancelText: { color: colors.dim, fontSize: 13.5, fontWeight: "600" },
  hint: { color: colors.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 2 },
  hintLink: { color: colors.a2, textDecorationLine: "underline" },
});
