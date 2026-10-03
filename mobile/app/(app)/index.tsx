import { ThemedInput as TextInput } from "../../src/components/ThemedInput";
import { ResponsiveText as Text } from "../../src/components/ResponsiveText";
/* Home: groups with collapsible channel lists and unread badges — the
   mobile take on the desktop sidebar (drill-down instead of split pane).
   Red badges mean @you; muted badges are plain traffic (Slack convention).
   The Threads row is the inbox entry; the filter chip hides read channels.
   Long-press a group or channel name for manage/delete actions. */

import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  MessagesSquare,
  ArrowUpRight,
  Hash,
} from "lucide-react-native";
import {
  useCreateChannel,
  useCreateGroup,
  useDeleteChannel,
  useDeleteGroup,
  useGroups,
  FEATURES,
  useAgentDms,
  useOpenAgentDm,
  useSetGroupHidden,
  useThreads,
  useUpdateChannel,
} from "@agora/core";
import type { Channel, Group } from "@agora/core";
import { Icon } from "../../src/components/Icon";
import { AgentAvatar } from "../../src/components/AgentAvatar";
import { AgentStatus } from "../../src/components/AgentStatus";
import { toastErr } from "../../src/components/Toast";
import { colors, typography, space, radii, weight } from "../../src/lib/theme";
import { usePrefs } from "../../src/state/prefs";
import { EmptyState } from "../../src/components/EmptyState";
import { brand, layout } from "../../src/lib/theme";
import { WorkspaceHeader } from "../../src/components/WorkspaceHeader";

function isGroupAdmin(group: Group): boolean {
  return group.role === "admin";
}

export function UnreadBadge({
  count,
  mentions = 0,
}: {
  count: number;
  mentions?: number;
}) {
  if (mentions > 0) {
    return (
      <View style={[styles.badge, styles.badgeMention]}>
        <Text maxFontSizeMultiplier={1.3} style={styles.badgeMentionText}>@ {mentions > 99 ? "99+" : mentions}</Text>
      </View>
    );
  }
  if (!count) return null;
  return (
    <View style={styles.badge}>
      <Text maxFontSizeMultiplier={1.3} style={styles.badgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

function InlineCreate({
  placeholder,
  initial = "",
  submitLabel = "Add",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <View style={styles.inlineCreate}>
      <TextInput
        style={styles.inlineInput}
        value={name}
        onChangeText={setName}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus
        autoCapitalize="none"
        onSubmitEditing={() => name.trim() && onSubmit(name.trim())}
      />
      <Pressable onPress={() => (name.trim() ? onSubmit(name.trim()) : onCancel())} hitSlop={8}>
        <Text style={styles.inlineOk}>{name.trim() ? submitLabel : "Cancel"}</Text>
      </Pressable>
    </View>
  );
}

function ChannelRow({ group, channel }: { group: Group; channel: Channel }) {
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const deleteChannel = useDeleteChannel();
  const updateChannel = useUpdateChannel();
  const admin = isGroupAdmin(group);

  const confirmDelete = () => {
    Alert.alert(
      `Delete #${channel.name}?`,
      "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteChannel.mutate(
              { groupId: group.id, channelId: channel.id },
              { onError: (e) => toastErr("Delete failed", e) },
            ),
        },
      ],
    );
  };

  const onLongPress = () => {
    // Hiding is a personal sidebar pref (anyone); rename/topic/delete edit
    // the shared channel (group admins only).
    const buttons: {
      text: string;
      style?: "cancel" | "destructive" | "default";
      onPress?: () => void;
    }[] = [];
    if (admin) {
      buttons.push(
        { text: "Rename", onPress: () => { setManaging(true); setEditing("name"); } },
        { text: "Edit topic", onPress: () => { setManaging(true); setEditing("topic"); } },
      );
    }
    buttons.push({
      text: "Hide channel",
      onPress: () =>
        updateChannel.mutate(
          { groupId: group.id, channelId: channel.id, hidden: true },
          { onError: (e) => toastErr("Hide failed", e) },
        ),
    });
    if (admin) {
      buttons.push({ text: "Delete channel", style: "destructive", onPress: confirmDelete });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(
      `#${channel.name}`,
      "Hiding tucks it into your Hidden section; nothing is deleted and nobody else's list changes.",
      buttons,
    );
  };

  return (
    <View>
      <Pressable
        hitSlop={{ top: 2, bottom: 2 }}
        style={({ pressed }) => [styles.channelRow, pressed && styles.rowPressed]}
        accessibilityRole="button"
        onPress={() =>
          router.push({
            pathname: "/(app)/channel/[id]",
            params: { id: channel.id, name: channel.name, groupId: group.id },
          })
        }
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <View style={[styles.channelGlyph, (channel.unread ?? 0) > 0 && styles.channelGlyphUnread]}>
          <Icon icon={Hash} size={17} color={(channel.unread ?? 0) > 0 ? colors.accentText : colors.faint} />
        </View>
        <View style={styles.channelCopy}>
          <Text style={[styles.channelName, (channel.unread ?? 0) > 0 && styles.channelUnread]} numberOfLines={1} maxFontSizeMultiplier={1.5}>
            {channel.name}
          </Text>
          {channel.topic ? <Text style={styles.channelTopic} numberOfLines={1}>{channel.topic}</Text> : null}
        </View>
        <UnreadBadge count={channel.unread ?? 0} mentions={channel.mentions ?? 0} />
      </Pressable>
      {managing && editing ? (
        <InlineCreate
          placeholder={editing === "name" ? "channel name" : "topic"}
          initial={editing === "name" ? channel.name : channel.topic}
          submitLabel="Save"
          onCancel={() => {
            setEditing(null);
            setManaging(false);
          }}
          onSubmit={(value) =>
            updateChannel.mutate(
              {
                groupId: group.id,
                channelId: channel.id,
                ...(editing === "name" ? { name: value } : { topic: value }),
              },
              {
                onSuccess: () => {
                  setEditing(null);
                  setManaging(false);
                },
                onError: (e) => toastErr("Update failed", e),
              },
            )
          }
        />
      ) : null}
    </View>
  );
}

function GroupCard({ group, unreadsOnly }: { group: Group; unreadsOnly: boolean }) {
  const collapsed = usePrefs((s) => !!s.collapsedGroups[group.id]);
  const toggleGroup = usePrefs((s) => s.toggleGroup);
  const [creating, setCreating] = useState(false);
  const createChannel = useCreateChannel();
  const deleteGroup = useDeleteGroup();
  const setGroupHidden = useSetGroupHidden();
  const admin = isGroupAdmin(group);
  // Hidden channels live in the Hidden section and don't feed the badges.
  const shownChannels = group.channels.filter((c) => !c.hidden);
  const unread = shownChannels.reduce((n, c) => n + (c.unread ?? 0), 0);
  const mentions = shownChannels.reduce((n, c) => n + (c.mentions ?? 0), 0);
  const expanded = !collapsed;
  const visibleChannels = unreadsOnly
    ? shownChannels.filter((c) => (c.unread ?? 0) > 0 || (c.mentions ?? 0) > 0)
    : shownChannels;

  const confirmDelete = () => {
    Alert.alert(
      `Delete ${group.name}?`,
      "This deletes the group and everything in it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteGroup.mutate(group.id, {
              onError: (e) => toastErr("Delete failed", e),
            }),
        },
      ],
    );
  };

  const onLongPress = () => {
    const buttons: {
      text: string;
      style?: "cancel" | "destructive" | "default";
      onPress?: () => void;
    }[] = [
      {
        text: "Members",
        onPress: () =>
          router.push({
            pathname: "/(app)/members/[groupId]",
            params: { groupId: group.id, name: group.name },
          }),
      },
    ];
    buttons.push({
      text: "Hide group",
      onPress: () =>
        setGroupHidden.mutate(
          { groupId: group.id, hidden: true },
          { onError: (e) => toastErr("Hide failed", e) },
        ),
    });
    if (admin) {
      buttons.push({ text: "Delete group", style: "destructive", onPress: confirmDelete });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(
      group.name,
      "Hiding tucks it into your Hidden section; nothing is deleted and nobody else's list changes.",
      buttons,
    );
  };

  if (unreadsOnly && visibleChannels.length === 0) return null;

  return (
    <View style={styles.groupCard}>
      <Pressable
        style={styles.groupHead}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => toggleGroup(group.id)}
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <View style={styles.groupMonogram}>
          <Text style={styles.groupInitial}>{group.name.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={styles.channelCopy}>
          <Text style={styles.groupName} numberOfLines={1} maxFontSizeMultiplier={1.5}>{group.name}</Text>
          <Text style={styles.groupMeta}>{shownChannels.length} {shownChannels.length === 1 ? "channel" : "channels"}</Text>
        </View>
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={16} color={colors.faint} />
        {!expanded ? <UnreadBadge count={unread} mentions={mentions} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`Create channel in ${group.name}`} onPress={() => setCreating((c) => !c)} style={styles.plusBtn}>
          <Text maxFontSizeMultiplier={1.2} style={styles.plus}>＋</Text>
        </Pressable>
      </Pressable>
      {creating ? (
        <InlineCreate
          placeholder="new channel name"
          onCancel={() => setCreating(false)}
          onSubmit={(name) =>
            createChannel.mutate(
              { groupId: group.id, name },
              {
                onSuccess: () => setCreating(false),
                onError: (e) => toastErr("Create failed", e),
              },
            )
          }
        />
      ) : null}
      {expanded
        ? visibleChannels.map((c) => <ChannelRow key={c.id} group={group} channel={c} />)
        : null}
      {expanded && group.channels.length === 0 ? (
        <Text style={styles.emptyChannels}>No channels yet — tap ＋</Text>
      ) : null}
    </View>
  );
}

export function DmGroupCard({ group, unreadsOnly, initialChoosing = false }: { group: Group; unreadsOnly: boolean; initialChoosing?: boolean }) {
  const [choosing, setChoosing] = useState(initialChoosing);
  const dms = useAgentDms();
  const open = useOpenAgentDm();
  const channels = unreadsOnly ? group.channels.filter(c => (c.unread ?? 0) > 0) : group.channels;
  const existing = new Set((dms.data?.conversations ?? []).map(dm => dm.agent_id));
  const available = (dms.data?.agents ?? []).filter(a => a.can_dm && !existing.has(a.id));
  return (
    <View style={styles.groupCard}>
      <View style={styles.groupHead}>
        <Icon icon={Bot} size={16} color={colors.a1} />
        <Text style={styles.groupName}>Direct messages</Text>
        <Pressable accessibilityLabel="Start a direct message with an agent" onPress={() => setChoosing(true)} hitSlop={10} style={styles.plusBtn}>
          <Text maxFontSizeMultiplier={1.2} style={styles.plus}>＋</Text>
        </Pressable>
      </View>
      <Modal transparent visible={choosing} animationType="fade" onRequestClose={() => setChoosing(false)}>
        <Pressable style={styles.dmModalScrim} onPress={() => setChoosing(false)}>
          <Pressable testID="agent-dm-modal-card" style={styles.dmModalCard} accessibilityViewIsModal onPress={() => undefined}>
            <View style={styles.dmModalHead}><View style={styles.dmModalTitleBlock}><Text style={styles.dmModalTitle}>New direct message</Text><Text style={styles.dmModalHint}>Choose an agent to message privately</Text></View>
              <Pressable accessibilityLabel="Close agent picker" onPress={() => setChoosing(false)} style={styles.dmModalClose}><Text style={styles.dmModalCloseText}>Close</Text></Pressable></View>
            <ScrollView style={styles.dmModalList} contentContainerStyle={styles.dmModalListContent}>
              {available.map(agent => <Pressable key={agent.id} disabled={open.isPending} style={({pressed}) => [styles.dmAgentRow, pressed && styles.dmAgentRowPressed]} onPress={() => open.mutate(agent.id, {
                onSuccess: channel => { setChoosing(false); router.push({ pathname: "/(app)/channel/[id]", params: { id: channel.id, name: channel.name, groupId: "__dms" } }); },
                onError: e => toastErr("Couldn't open DM", e),
              })}><AgentAvatar agentId={agent.id} size={30}/><Text numberOfLines={1} style={styles.channelName}>{agent.name}</Text><AgentStatus live={agent.live}/></Pressable>)}
              {dms.isLoading ? <Text style={styles.dmModalEmpty}>Loading agents…</Text> : null}
              {dms.isError ? <Text style={styles.dmModalEmpty}>Couldn't load available agents.</Text> : null}
              {dms.isSuccess && !available.length ? <Text style={styles.dmModalEmpty}>No new agents are available to message.</Text> : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      {channels.map(channel => (
        <Pressable key={channel.id} style={styles.channelRow} onPress={() => router.push({
          pathname: "/(app)/channel/[id]", params: { id: channel.id, name: channel.name, groupId: "__dms" },
        })}>
          <Text maxFontSizeMultiplier={1.3} style={styles.hash}>↔</Text><Text maxFontSizeMultiplier={1.5} style={[styles.channelName, (channel.unread ?? 0) > 0 && styles.channelUnread]}>{channel.name}</Text>
          <UnreadBadge count={channel.unread ?? 0} />
        </Pressable>
      ))}
    </View>
  );
}

/* Collapsed drawer of hidden groups/channels at the bottom of the home list:
   they stay reachable (tap to open) and restorable (tap the eye) without
   crowding the main list. */
function HiddenSection({ groups }: { groups: Group[] }) {
  const [open, setOpen] = useState(false);
  const setGroupHidden = useSetGroupHidden();
  const updateChannel = useUpdateChannel();
  const hiddenGroups = groups.filter((g) => g.hidden);
  const hiddenChannels = groups
    .filter((g) => !g.hidden)
    .flatMap((g) => g.channels.filter((c) => c.hidden).map((c) => ({ group: g, channel: c })));
  const count = hiddenGroups.length + hiddenChannels.length;
  if (!count) return null;
  return (
    <View style={styles.hiddenCard}>
      <Pressable style={styles.hiddenHead} onPress={() => setOpen((o) => !o)}>
        <View style={styles.chevron}>
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} color={colors.faint} />
        </View>
        <Icon icon={EyeOff} size={14} color={colors.faint} />
        <Text style={styles.hiddenTitle}>Hidden</Text>
        <Text style={styles.hiddenCount}>{count}</Text>
      </Pressable>
      {open
        ? hiddenGroups.map((g) => (
            <View key={g.id} style={styles.hiddenRow}>
              <Text style={styles.hiddenName} numberOfLines={1}>
                {g.name}
              </Text>
              {/* Un-hiding is a personal pref — everyone gets the eye. */}
              <Pressable
                hitSlop={10}
                onPress={() =>
                  setGroupHidden.mutate(
                    { groupId: g.id, hidden: false },
                    { onError: (e) => toastErr("Show failed", e) },
                  )
                }
              >
                <Icon icon={Eye} size={17} color={colors.a1} />
              </Pressable>
            </View>
          ))
        : null}
      {open
        ? hiddenChannels.map(({ group, channel }) => (
            <View key={channel.id} style={styles.hiddenRow}>
              <Pressable
                style={styles.hiddenChanBtn}
                onPress={() =>
                  router.push({
                    pathname: "/(app)/channel/[id]",
                    params: { id: channel.id, name: channel.name, groupId: group.id },
                  })
                }
              >
                <Text style={styles.hiddenName} numberOfLines={1}>
                  <Text style={styles.hash}># </Text>
                  {channel.name}
                  <Text style={styles.hiddenGroupSuffix}> · {group.name}</Text>
                </Text>
              </Pressable>
              <Pressable
                hitSlop={10}
                onPress={() =>
                  updateChannel.mutate(
                    { groupId: group.id, channelId: channel.id, hidden: false },
                    { onError: (e) => toastErr("Show failed", e) },
                  )
                }
              >
                <Icon icon={Eye} size={17} color={colors.a1} />
              </Pressable>
            </View>
          ))
        : null}
    </View>
  );
}

export default function Home() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const groups = useGroups();
  const threads = useThreads();
  const createGroup = useCreateGroup();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const loadPrefs = usePrefs((s) => s.load);
  const unreadsOnly = usePrefs((s) => s.unreadsOnly);
  const setUnreadsOnly = usePrefs((s) => s.setUnreadsOnly);
  const expandGroup = usePrefs((s) => s.expandGroup);
  useEffect(() => {
    if (!prefsLoaded) void loadPrefs();
  }, [prefsLoaded, loadPrefs]);
  useEffect(() => {
    if (prefsLoaded && groupId) expandGroup(groupId);
  }, [prefsLoaded, groupId, expandGroup]);

  const visibleGroups = (groups.data ?? []).filter(group => !group.hidden);
  const visibleChannels = new Set(visibleGroups.flatMap(group => (group.channels || [])
    .filter(channel => !channel.hidden).map(channel => channel.id)));
  const countedUnread = visibleGroups.reduce((sum, group) => sum + (group.channels || [])
    .filter(channel => !channel.hidden).reduce((n, channel) => n + (channel.unread ?? 0), 0), 0)
    + (threads.data ?? []).reduce((sum, thread) => sum +
      (visibleChannels.has(thread.channel_id) ? thread.unread ?? 0 : 0), 0);
  const inboxMentions = visibleGroups.reduce((sum, group) => sum + (group.channels || [])
    .filter(channel => !channel.hidden).reduce((n, channel) => n + (channel.mentions ?? 0), 0), 0);
  const inboxUnread = Math.max(countedUnread, inboxMentions);

  return (
    <>
      <Stack.Screen options={{ title: brand.name, headerShown: false }} />
      <WorkspaceHeader />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={groups.isRefetching}
            onRefresh={() => {
              void groups.refetch();
              void threads.refetch();
            }}
            tintColor={colors.dim}
          />
        }
      >
        <View style={styles.topRow}>
          <Pressable
            accessibilityRole="button"
            style={styles.threadsRow}
            onPress={() => router.push("/(app)/inbox")}
          >
            <View style={styles.inboxIcon}><Icon icon={MessagesSquare} size={23} color={colors.a1} /></View>
            <View style={styles.inboxCopy}>
              <Text maxFontSizeMultiplier={1.5} numberOfLines={2} style={styles.threadsLabel}>Inbox</Text>
              <Text style={styles.inboxHint}>{inboxUnread > 0 ? "Pick up where you left off" : "A little room to breathe. All caught up."}</Text>
            </View>
            {inboxUnread > 0 ? (
              <View style={[styles.badge, inboxMentions > 0 ? styles.badgeMention : styles.badgeThread]}
                accessibilityLabel={`${inboxUnread} unread messages, ${inboxMentions} mentions`}>
                <Text maxFontSizeMultiplier={1.3} style={[styles.badgeText, inboxMentions > 0 && { color: colors.onAccent }]}>
                  {inboxUnread > 99 ? "99+" : inboxUnread}{inboxMentions > 0 ? ` · @${inboxMentions > 99 ? "99+" : inboxMentions}` : ""}
                </Text>
              </View>
            ) : null}
            <Icon icon={ArrowUpRight} size={19} color={colors.accentText} />
          </Pressable>
        </View>
        <View style={styles.sectionRow}>
          <Text accessibilityRole="header" style={styles.sectionLabel}>YOUR GROUPS</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show unread channels only"
            accessibilityState={{ selected: unreadsOnly }}
            style={[styles.filterChip, unreadsOnly ? styles.filterChipOn : null]}
            onPress={() => setUnreadsOnly(!unreadsOnly)}
            hitSlop={6}
          >
            <Text maxFontSizeMultiplier={1.5} style={[styles.filterText, unreadsOnly ? styles.filterTextOn : null]}>
              {unreadsOnly ? "Unread only" : "All channels"}
            </Text>
          </Pressable>
        </View>
        {[...(groups.data ?? []).filter(g => g.kind !== "agent_dms"), ...(groups.data ?? []).filter(g => g.kind === "agent_dms")]
          .filter((g) => !g.hidden)
          .map((g) => (
            FEATURES.dms && g.kind === "agent_dms"
              ? <DmGroupCard key={g.id} group={g} unreadsOnly={unreadsOnly} />
              : <GroupCard key={g.id} group={g} unreadsOnly={unreadsOnly} />
          ))}
        {groups.isSuccess && groups.data.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="Make room for good work" description="Create your first group, then bring your people and agents together."
            action={{ label: "Create a group", onPress: () => setCreatingGroup(true) }} />
        ) : null}
        {groups.isSuccess && unreadsOnly && visibleGroups.length > 0 && !visibleGroups.some(group => group.channels.some(channel => !channel.hidden && ((channel.unread ?? 0) > 0 || (channel.mentions ?? 0) > 0))) ?
          <EmptyState icon={MessagesSquare} title="All caught up" description="Your channels are quiet. Switch back to see every conversation."
            action={{ label: "Show all channels", onPress: () => setUnreadsOnly(false) }} /> : null}
        {groups.isSuccess && groups.data.length > 0 && unreadsOnly ? (
          <Text style={styles.filterHint}>Showing unread channels only.</Text>
        ) : null}
        {groups.isError ? (
          <Text style={styles.empty}>Couldn't load groups: {groups.error.message}</Text>
        ) : null}
        <HiddenSection groups={groups.data ?? []} />
        {creatingGroup ? (
          <InlineCreate
            placeholder="new group name"
            onCancel={() => setCreatingGroup(false)}
            onSubmit={(name) =>
              createGroup.mutate(
                { name },
                {
                  onSuccess: () => setCreatingGroup(false),
                  onError: (e) => toastErr("Create failed", e),
                },
              )
            }
          />
        ) : (
          <Pressable style={styles.newGroup} onPress={() => setCreatingGroup(true)}>
            <Text style={styles.newGroupText}>＋ New group</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: layout.gutter, paddingTop: space.md, gap: space.md, paddingBottom: layout.contentBottom },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionLabel: { ...typography.eyebrow, color: colors.faint },
  inboxHint: { ...typography.caption, color: colors.dim, flexShrink: 1 },
  channelCopy: { flex: 1, minWidth: 0, gap: 2 },
  channelTopic: { ...typography.caption, color: colors.faint },
  channelGlyph: { width: 28, height: 28, borderRadius: radii.sm, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  channelGlyphUnread: { backgroundColor: colors.accentSoft },
  groupMonogram: { width: 34, height: 34, borderRadius: radii.md, backgroundColor: colors.mintSoft, alignItems: "center", justifyContent: "center" },
  groupInitial: { ...typography.bodySm, color: colors.a2, fontWeight: weight.bold },
  groupMeta: { ...typography.caption, color: colors.faint },
  inboxIcon: { width: 42, height: 42, borderRadius: radii.md, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  inboxCopy: { flex: 1, gap: space.xs },
  rowPressed: { backgroundColor: colors.panelStrong },
  channelUnread: { color: colors.text, fontWeight: weight.semibold },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  threadsRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.accentWash,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    borderRadius: radii.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  threadsLabel: { fontSize: typography.title.fontSize, fontWeight: typography.title.fontWeight, color: colors.text },
  filterChip: {
    minHeight: 44, justifyContent: "center",
    borderRadius: radii.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  filterChipOn: { backgroundColor: colors.accentSoft, borderColor: colors.a1 },
  filterText: { color: colors.dim, fontSize: typography.meta.fontSize, fontWeight: weight.bold },
  filterTextOn: { color: colors.a1 },
  filterHint: { color: colors.faint, fontSize: typography.caption.fontSize, textAlign: "center" },
  groupCard: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    paddingBottom: space.sm,
    overflow: "hidden",
  },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    marginBottom: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  chevron: { width: 14, alignItems: "center" },
  groupName: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.bold, flex: 1 },
  plusBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  plus: { color: colors.dim, fontSize: typography.title.fontSize },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    minHeight: 48,
  },
  hash: { color: colors.faint, fontSize: typography.bodySm.fontSize },
  channelName: { fontSize: typography.message.fontSize, fontWeight: typography.message.fontWeight, color: colors.dim, flex: 1 },
  dmModalScrim: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(4,6,10,0.78)" },
  dmModalCard: { width: "100%", maxWidth: 440, maxHeight: "78%", alignSelf: "center", padding: 18, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 18, backgroundColor: colors.sheet },
  dmModalHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 14 },
  dmModalTitleBlock: { flex: 1, gap: 3 },
  dmModalTitle: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: weight.bold },
  dmModalHint: { color: colors.dim, fontSize: typography.meta.fontSize },
  dmModalClose: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 6 },
  dmModalCloseText: { color: colors.text, fontSize: typography.meta.fontSize, fontWeight: weight.bold },
  dmModalList: { marginTop: 16 },
  dmModalListContent: { gap: 8 },
  dmAgentRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 11, backgroundColor: colors.panel },
  dmAgentRowPressed: { backgroundColor: colors.accentSoft },
  dmModalEmpty: { color: colors.dim, padding: 14, textAlign: "center", lineHeight: 19 },
  badge: {
    backgroundColor: colors.panelStrong,
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
  badgeMention: { backgroundColor: colors.red },
  badgeMentionText: { color: colors.onAccent, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
  badgeThread: { backgroundColor: colors.accentBorder },
  inlineCreate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  inlineInput: {
    flex: 1,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: typography.bodySm.fontSize,
  },
  inlineOk: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  emptyChannels: { color: colors.faint, fontSize: typography.meta.fontSize, paddingLeft: 34, paddingVertical: 8 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 30, fontSize: typography.bodySm.fontSize },
  newGroup: { alignItems: "center", paddingVertical: 12 },
  newGroupText: { color: colors.a1, fontSize: typography.message.fontSize, fontWeight: weight.bold },
  hiddenCard: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: 14,
    paddingVertical: 2,
  },
  hiddenHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  hiddenTitle: { color: colors.dim, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold, flex: 1 },
  hiddenCount: {
    color: colors.faint,
    fontSize: typography.caption.fontSize,
    fontWeight: weight.bold,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 9,
    minWidth: 20,
    textAlign: "center",
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
  hiddenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 34,
    paddingRight: 14,
    paddingVertical: 9,
  },
  hiddenChanBtn: { flex: 1 },
  hiddenName: { color: colors.dim, fontSize: typography.bodySm.fontSize, flex: 1 },
  hiddenGroupSuffix: { color: colors.faint, fontSize: typography.meta.fontSize },
});
