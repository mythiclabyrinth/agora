import React, { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { ChevronRight, Plus, User, X } from "lucide-react-native";
import { useAddMember, useAllMemberships, useGroups, useMe, useRemoveMember, useUsers } from "@agora/core";
import type { Group, InstanceMembership } from "@agora/core";
import { Icon } from "../../../src/components/Icon";
import { toast, toastErr } from "../../../src/components/Toast";
import { colors } from "../../../src/lib/theme";
import { RoleDropdown } from "../../../src/components/RoleDropdown";

type ScopeChoice = { groupId: string; channelId: string | null; label: string };

export default function PersonAccessScreen() {
  const { username = "" } = useLocalSearchParams<{ username: string }>();
  const me = useMe();
  const users = useUsers(me.data?.instance_admin === true);
  const memberships = useAllMemberships(me.data?.instance_admin === true);
  const groups = useGroups();
  const addMember = useAddMember();
  const removeMember = useRemoveMember();
  const [adding, setAdding] = useState(false);
  const [pickedGroup, setPickedGroup] = useState<Group | null>(null);
  const [pickedScope, setPickedScope] = useState<ScopeChoice | null>(null);
  const user = (users.data ?? []).find(item => item.username === username);
  const rows = useMemo(() => (memberships.data ?? []).filter(row => row.member_type === "user" && row.member_id === username), [memberships.data, username]);
  const byGroup = useMemo(() => {
    const result = new Map<string, InstanceMembership[]>();
    for (const row of rows) result.set(row.group_id, [...(result.get(row.group_id) ?? []), row]);
    return result;
  }, [rows]);

  const resetAdd = () => { setAdding(false); setPickedGroup(null); setPickedScope(null); };
  const add = (role: "member" | "admin") => {
    if (!pickedScope) return;
    addMember.mutate({ group_id: pickedScope.groupId, member_type: "user", member_id: username, role, channel_id: pickedScope.channelId ?? undefined }, {
      onSuccess: () => { toast(`${user?.display_name || username} now has ${pickedScope.label} access.`); resetAdd(); },
      onError: error => toastErr("Add access failed", error),
    });
  };
  const setRole = (row: InstanceMembership, role: "member" | "admin") => addMember.mutate({
    group_id: row.group_id, member_type: "user", member_id: username, role, channel_id: row.channel_id ?? undefined,
  }, { onError: error => toastErr("Role change failed", error) });
  const remove = (row: InstanceMembership) => Alert.alert("Remove access?", `${user?.display_name || username} will lose access to ${row.channel_name ? `#${row.channel_name}` : row.group_name}.`, [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: () => removeMember.mutate({ group_id: row.group_id, member_type: "user", member_id: username, channel_id: row.channel_id }, { onError: error => toastErr("Remove access failed", error) }) },
  ]);
  const convert = (group: Group, channelId: string, role: "member" | "admin") => Alert.alert(
    "Change to channel access?",
    `This first removes all ${group.name} access, then adds access to #${group.channels.find(channel => channel.id === channelId)?.name ?? channelId}. This cannot be undone atomically.`,
    [{ text: "Cancel", style: "cancel" }, { text: "Change access", style: "destructive", onPress: async () => {
      try {
        await removeMember.mutateAsync({ group_id: group.id, member_type: "user", member_id: username, all_scopes: true });
        try {
          await addMember.mutateAsync({ group_id: group.id, member_type: "user", member_id: username, channel_id: channelId, role });
          toast(`Access changed to #${group.channels.find(channel => channel.id === channelId)?.name ?? channelId}.`);
        } catch (error) {
          toastErr("Group access was removed, but channel access could not be added", error);
        }
      } catch (error) { toastErr("Access change failed before anything was removed", error); }
      resetAdd();
    } }],
  );

  if (!me.isSuccess) return null;
  if (!me.data.instance_admin) return <View style={[styles.root, styles.content]}><Stack.Screen options={{ title: "Person", headerShown: true }} /><Text style={styles.hint}>Instance admin access required.</Text></View>;
  return <>
    <Stack.Screen options={{ title: user?.display_name || username, headerShown: true }} />
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.profile}><View style={styles.avatar}><Icon icon={User} size={24} /></View><View style={{ flex: 1 }}>
        <Text style={styles.title}>{user?.display_name || username}</Text><Text style={styles.meta}>@{username}{user?.instance_role === "admin" ? " · instance admin" : ""}</Text>
      </View></View>
      <Text style={styles.section}>Access</Text>
      {[...byGroup.entries()].map(([groupId, groupRows]) => <View key={groupId} style={styles.card}>
        <Text style={styles.groupName}>{groupRows[0].group_name}</Text>
        {groupRows.map(row => { const shadowed = !!row.channel_id && groupRows.some(candidate => !candidate.channel_id); return <View key={row.channel_id ?? "group"} style={styles.scopeRow}>
          <View style={{ flex: 1 }}><Text style={styles.scopeName}>{row.channel_name ? `# ${row.channel_name}` : "Whole group"}</Text></View>
          {shadowed ? <View><Text style={styles.staticRole}>{row.role}</Text><Text style={styles.meta}>Included in whole-group access</Text></View> : <RoleDropdown value={row.role === "admin" ? "admin" : "member"} onChange={role => setRole(row, role)} />}
          <Pressable accessibilityLabel={`Remove ${row.channel_name ?? row.group_name} access`} style={styles.removeButton} onPress={() => remove(row)}><Icon icon={X} size={15} color={colors.dim} /></Pressable>
        </View>;})}
      </View>)}
      {memberships.isSuccess && rows.length === 0 ? <Text style={styles.empty}>No group access yet.</Text> : null}
      {!adding ? <Pressable style={styles.addButton} onPress={() => setAdding(true)}><Icon icon={Plus} size={17} color={colors.a1} /><Text style={styles.addText}>Add access</Text></Pressable> :
        <View style={styles.addCard}>
          {!pickedGroup ? <><Text style={styles.addTitle}>Choose a group</Text>{(groups.data ?? []).filter(group => group.kind !== "agent_dms").map(group => <Pressable key={group.id} style={styles.option} onPress={() => setPickedGroup(group)}><Text style={styles.scopeName}>{group.name}</Text><Icon icon={ChevronRight} size={17} color={colors.faint} /></Pressable>)}</> :
          !pickedScope ? <ScopePicker group={pickedGroup} existing={byGroup.get(pickedGroup.id) ?? []} onPick={setPickedScope} onConvert={(channelId, role) => convert(pickedGroup, channelId, role)} /> :
          <><Text style={styles.addTitle}>Choose a role for {pickedScope.label}</Text><RoleChoice label="Member" detail="Can read and participate" onPress={() => add("member")} /><RoleChoice label="Admin" detail="Can manage this scope" onPress={() => add("admin")} /></>}
          <Pressable style={styles.cancel} onPress={pickedScope ? () => setPickedScope(null) : pickedGroup ? () => setPickedGroup(null) : resetAdd}><Text style={styles.cancelText}>‹ Back</Text></Pressable>
        </View>}
    </ScrollView>
  </>;
}

function ScopePicker({ group, existing, onPick, onConvert }: { group: Group; existing: InstanceMembership[]; onPick: (scope: ScopeChoice) => void; onConvert: (channelId: string, role: "member" | "admin") => void }) {
  const wholeGroup = existing.find(row => !row.channel_id);
  const existingChannels = new Set(existing.map(row => row.channel_id));
  return <><Text style={styles.addTitle}>Choose access in {group.name}</Text>
    {!wholeGroup ? <Pressable style={styles.option} onPress={() => onPick({ groupId: group.id, channelId: null, label: `${group.name} · whole group` })}><Text style={styles.scopeName}>Whole group</Text><Icon icon={ChevronRight} size={17} color={colors.faint} /></Pressable> : null}
    {group.channels.map(channel => {
      const alreadyAdded = existingChannels.has(channel.id);
      return <View key={channel.id}>
        <Pressable disabled={!!wholeGroup || alreadyAdded} style={[styles.option, (!!wholeGroup || alreadyAdded) && styles.optionDisabled]} onPress={() => onPick({ groupId: group.id, channelId: channel.id, label: `${group.name} · #${channel.name}` })}>
          <View><Text style={styles.scopeName}># {channel.name}</Text>{alreadyAdded ? <Text style={styles.meta}>Already added</Text> : wholeGroup ? <Text style={styles.meta}>Included in whole-group access</Text> : null}</View>
          {!wholeGroup && !alreadyAdded ? <Icon icon={ChevronRight} size={17} color={colors.faint} /> : null}
        </Pressable>
        {wholeGroup ? <View style={styles.convertRow}><Pressable onPress={() => onConvert(channel.id, wholeGroup.role === "admin" ? "admin" : "member")}><Text style={styles.convertText}>Change to only this channel…</Text></Pressable></View> : null}
      </View>;
    })}
  </>;
}

function RoleChoice({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) { return <Pressable style={styles.roleChoice} onPress={onPress}><Text style={styles.scopeName}>{label}</Text><Text style={styles.meta}>{detail}</Text></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg }, content: { padding: 16, gap: 10, paddingBottom: 50 }, hint: { color: colors.dim },
  profile: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 }, avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.panelStrong, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" }, meta: { color: colors.dim, fontSize: 12, marginTop: 2 },
  section: { color: colors.dim, fontSize: 11.5, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginTop: 8 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 13, padding: 12, gap: 2 }, groupName: { color: colors.text, fontSize: 15, fontWeight: "700", marginBottom: 4 },
  scopeRow: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.border }, scopeName: { color: colors.text, fontSize: 13.5, fontWeight: "600" },
  removeButton: { padding: 8 }, empty: { color: colors.faint, textAlign: "center", paddingVertical: 18 },
  staticRole: { color: colors.a1, fontWeight: "700", fontSize: 12, textTransform: "capitalize" },
  addButton: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, padding: 13 }, addText: { color: colors.a1, fontWeight: "700" },
  addCard: { borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panel, borderRadius: 14, padding: 12, gap: 7 }, addTitle: { color: colors.text, fontWeight: "700", fontSize: 15, marginBottom: 3 },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }, optionDisabled: { opacity: 0.55 }, convertRow: { alignItems: "flex-end", paddingVertical: 5, paddingRight: 4 }, convertText: { color: colors.a2, fontSize: 12, fontWeight: "600" },
  roleChoice: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10, padding: 12 }, cancel: { alignItems: "center", padding: 9 }, cancelText: { color: colors.dim, fontWeight: "600" },
});
