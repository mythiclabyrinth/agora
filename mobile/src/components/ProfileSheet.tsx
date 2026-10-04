/* Profile card opened by tapping a message author's avatar: an agent's
   picture plus everything /api/agents knows about it (home connection, live
   status, last seen, mention requirement), or a person's account details
   from /api/users. Same bottom-sheet pattern as the channel screen's
   MessageActions. */

import React from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { CalendarDays, Cable, Copy, Mail, MessageSquare, Clock3, type LucideIcon } from "lucide-react-native";
import { useAgents, useAgentUsage, useUsers } from "@agora/core";
import type { Message } from "@agora/core";
import { fmtTs } from "@agora/core";
import { radii, space, typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { AgentAvatar } from "./AgentAvatar";
import { SheetHeader } from "./SheetHeader";
import { ResponsiveText as Text } from "./ResponsiveText";
import { Icon } from "./Icon";
import { toast, toastErr } from "./Toast";

function Row({ label, value, icon, copy = false, mono = false }: { label: string; value: string; icon: LucideIcon; copy?: boolean; mono?: boolean }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}><Icon icon={icon} size={18} color={colors.faint} /></View>
      <View style={styles.rowBody}>
        <Text style={styles.rowKey}>{label}</Text>
        <Text selectable style={[styles.rowVal, mono && styles.mono]}>{value}</Text>
      </View>
      {copy ? <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${label.toLowerCase()}`} style={styles.copy} onPress={async () => {
        try { await Clipboard.setStringAsync(value); toast(`${label} copied.`); }
        catch (error) { toastErr("Copy failed", error); }
      }}><Icon icon={Copy} size={17} color={colors.dim} /></Pressable> : null}
    </View>
  );
}

function usageAge(ts: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - ts);
  if (seconds < 60) return "Updated just now";
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)}h ago`;
  return `Updated ${Math.floor(seconds / 86400)}d ago`;
}

function useBoundedRefreshing(refreshing: boolean, updatedAt: number): boolean {
  const [expired, setExpired] = React.useState(false);
  React.useEffect(() => {
    setExpired(false);
    if (!refreshing) return;
    const remaining = Math.max(0, 30_000 - (Date.now() - updatedAt));
    if (!remaining) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [refreshing, updatedAt]);
  return refreshing && !expired && Date.now() - updatedAt < 30_000;
}

export function ProfileSheet({ message, onClose }: { message: Message; onClose: () => void }) {
  const styles = useStyles();
  const isAgent = message.author_type === "agent";
  const agents = useAgents();
  const users = useUsers(!isAgent);
  const usageQuery = useAgentUsage(isAgent ? message.author_id : "");
  const usageRefreshing = useBoundedRefreshing(!!usageQuery.data?.refreshing, usageQuery.dataUpdatedAt);
  const agent = isAgent
    ? ((agents.data ?? []).find((a) => a.id === message.author_id) ?? null)
    : null;
  const user = !isAgent
    ? ((users.data ?? []).find((u) => u.username === message.author_id) ?? null)
    : null;
  const name = agent?.name || user?.display_name || message.author_name || message.author_id;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.backdrop} onPress={onClose}>
        <Pressable accessible={false} accessibilityViewIsModal style={[styles.sheet, { maxHeight: "85%" }]} onPress={event => event.stopPropagation()}>
          <SheetHeader title="Profile" onClose={onClose} />
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.top}>
              {isAgent ? <AgentAvatar agentId={message.author_id} size={60} /> : <View accessible={false} style={styles.userAvatar}>
                <Text maxFontSizeMultiplier={1.2} style={styles.userInitial}>{name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?"}</Text>
              </View>}
              <View style={styles.id}>
                <Text accessibilityRole="header" style={styles.name}>{name}</Text>
                <Text selectable style={styles.sub}>@{message.author_id}</Text>
              </View>
            </View>
            <View style={styles.badges}>
              <View style={[styles.badge, isAgent ? styles.agentBadge : styles.personBadge]}>
                <Text style={[styles.badgeText, isAgent ? styles.agentBadgeText : styles.personBadgeText]}>{isAgent ? "AI agent" : user ? `Workspace ${user.instance_role === "admin" ? "admin" : "member"}` : "Person"}</Text>
              </View>
              {agent ? <View style={styles.badge}>
                <View style={[styles.dot, agent.live ? styles.dotOn : styles.dotOff]} /><Text style={[styles.badgeText, agent.live && styles.online]}>{agent.live ? "Online" : "Offline"}</Text>
              </View> : null}
              {user?.disabled ? <View style={styles.badge}><Text style={styles.badgeText}>Deactivated</Text></View> : null}
            </View>
            {agent ? <>
              <View style={styles.rows}>
                <Row icon={MessageSquare} label="Replies" value={agent.requires_mention ? "When mentioned" : "To all messages"} />
                {!agent.live ? <Row icon={Clock3} label="Last seen" value={fmtTs(agent.last_seen)} /> : null}
                {agent.source ? <Row icon={Cable} label="Connection" value={agent.source} copy mono /> : null}
              </View>
              <AgentUsageBlock data={usageQuery.data} live={agent.live} refreshing={usageRefreshing} />
            </> : null}
            {user ? <View style={styles.rows}>
              {user.email ? <Row icon={Mail} label="Email" value={user.email} copy /> : null}
              <Row icon={CalendarDays} label="Joined" value={fmtTs(user.created_at)} />
            </View> : null}
            {!agent && !user ? <View style={styles.unavailable}>
              <Text style={styles.sub}>{(isAgent ? agents.isPending : users.isPending) ? "Loading profile…" : (isAgent ? agents.isError : users.isError) ? "Couldn't load profile details." : "No additional profile details available."}</Text>
              {(isAgent ? agents.isError : users.isError) ? <Pressable accessibilityRole="button" accessibilityLabel="Retry profile" style={styles.retry} onPress={() => void (isAgent ? agents.refetch() : users.refetch())}><Text style={styles.retryText}>Try again</Text></Pressable> : null}
            </View> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AgentUsageBlock({ data, live, refreshing }: { data: ReturnType<typeof useAgentUsage>["data"]; live: boolean; refreshing: boolean }) {
  const styles = useStyles();
  const usage = data?.usage;
  if (!usage || usage.windows.length === 0) return null;
  const freshness = refreshing ? "Updating…" : usageAge(usage.captured_at);
  return (
    <View style={styles.usageCard}>
      <View style={styles.usageHeading}><Text style={styles.usageTitle}>USAGE{usage.plan ? ` · ${usage.plan.toUpperCase()}` : ""}</Text><Text style={styles.usageNote}>{freshness}{!live ? " · agent offline" : data?.stale ? " · may be outdated" : ""}</Text></View>
      {usage.windows.map(window => <View key={window.key} style={styles.usageWindow}>
        <View style={styles.usageHeading}><Text style={styles.usageLabel}>{window.label}</Text><Text style={styles.usagePercent}>{Math.round(window.used_percent)}% used</Text></View>
        <View style={styles.usageTrack}><View style={[styles.usageFill, { width: `${Math.max(0, Math.min(100, window.used_percent))}%` }]} /></View>
        {window.resets_at ? <Text style={styles.usageNote}>Resets {new Date(window.resets_at * 1000).toLocaleString()}</Text> : null}
      </View>)}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, paddingBottom: 32 },
  content: { gap: space.lg, paddingTop: space.sm, paddingBottom: space.sm },
  top: { flexDirection: "row", alignItems: "center", gap: space.lg },
  id: { flex: 1, minWidth: 0, gap: space.xs },
  name: { color: colors.text, ...typography.title, fontWeight: weight.bold },
  sub: { color: colors.dim, ...typography.bodySm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.panelStrong, borderRadius: radii.pill },
  badgeText: { color: colors.dim, ...typography.caption, fontWeight: weight.semibold },
  agentBadge: { backgroundColor: colors.accentSoft }, agentBadgeText: { color: colors.accentText },
  personBadge: { backgroundColor: colors.mintSoft }, personBadgeText: { color: colors.a2 },
  online: { color: colors.green },
  dot: { width: 7, height: 7, borderRadius: 4 }, dotOn: { backgroundColor: colors.green }, dotOff: { backgroundColor: colors.faint },
  userAvatar: { width: 60, height: 60, borderRadius: radii.lg, backgroundColor: colors.mintSoft, borderWidth: 1, borderColor: colors.mintBorder, alignItems: "center", justifyContent: "center" },
  userInitial: { color: colors.a2, fontSize: 22, fontWeight: weight.bold },
  rows: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: space.xs },
  row: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingLeft: space.sm, paddingVertical: space.md, paddingRight: space.xs },
  rowIcon: { width: 24, paddingTop: 2, alignItems: "center" },
  rowBody: { flex: 1, minWidth: 0, gap: space.xs },
  rowKey: { color: colors.faint, ...typography.caption },
  rowVal: { color: colors.text, ...typography.bodySm },
  mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: typography.caption.fontSize, lineHeight: 19 },
  copy: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
  unavailable: { gap: space.sm }, retry: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }, retryText: { color: colors.a1, ...typography.bodySm },
  usageCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: space.lg, gap: space.md },
  usageHeading: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: space.sm },
  usageTitle: { color: colors.text, ...typography.caption, fontWeight: weight.bold },
  usageWindow: { gap: space.sm }, usageLabel: { color: colors.text, ...typography.bodySm },
  usagePercent: { color: colors.accentText, ...typography.caption, fontWeight: weight.semibold },
  usageTrack: { height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.panelStrong },
  usageFill: { height: "100%", backgroundColor: colors.a1 }, usageNote: { color: colors.dim, ...typography.caption },
}));
