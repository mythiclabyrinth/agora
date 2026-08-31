/* Profile card opened by tapping a message author's avatar: an agent's
   picture plus everything /api/agents knows about it (home connection, live
   status, last seen, mention requirement), or a person's account details
   from /api/users. Same bottom-sheet pattern as the channel screen's
   MessageActions. */

import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useAgents, useAgentUsage, useUsers } from "@agora/core";
import type { Message } from "@agora/core";
import { fmtTs } from "@agora/core";
import { colors } from "../lib/theme";
import { AgentAvatar } from "./AgentAvatar";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey} numberOfLines={1}>
        {k}
      </Text>
      <Text style={styles.rowVal}>{v}</Text>
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
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <View style={styles.top}>
            {isAgent ? (
              <AgentAvatar agentId={message.author_id} size={64} />
            ) : (
              <View style={styles.userAvatar}>
                <Text style={styles.userInitial}>{(name || "?")[0].toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.id}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>
                  {name}
                </Text>
                {agent ? (
                  <View style={[styles.dot, agent.live ? styles.dotOn : styles.dotOff]} />
                ) : null}
              </View>
              <Text style={styles.sub} numberOfLines={1}>
                @{message.author_id} · {isAgent ? "agent" : "person"}
              </Text>
            </View>
          </View>
          {agent ? (
            <View style={styles.rows}>
              <Row
                k="Status"
                v={agent.live ? "Online" : `Offline · last seen ${fmtTs(agent.last_seen)}`}
              />
              {agent.source ? <Row k="Connection" v={agent.source} /> : null}
              <AgentUsageBlock data={usageQuery.data} live={agent.live} refreshing={usageRefreshing} />
            </View>
          ) : null}
          {user ? (
            <View style={styles.rows}>
              <Row k="Role" v={user.instance_role} />
              {user.email ? <Row k="Email" v={user.email} /> : null}
              <Row k="Joined" v={fmtTs(user.created_at)} />
            </View>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

function AgentUsageBlock({ data, live, refreshing }: { data: ReturnType<typeof useAgentUsage>["data"]; live: boolean; refreshing: boolean }) {
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 14 },
  id: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: 17, fontWeight: "700", flexShrink: 1 },
  sub: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotOn: { backgroundColor: colors.green },
  dotOff: { backgroundColor: colors.faint },
  userAvatar: {
    width: 64,
    height: 64,
    borderRadius: 19,
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  userInitial: { color: colors.a2, fontSize: 28, fontWeight: "700" },
  rows: { gap: 10 },
  row: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  rowKey: {
    width: 110,
    color: colors.dim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  rowVal: { color: colors.text, fontSize: 13.5, flex: 1 },
  usageCard: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, gap: 10, marginTop: 3 },
  usageHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  usageTitle: { color: colors.text, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  usageWindow: { gap: 5 },
  usageLabel: { color: colors.text, fontSize: 12.5 },
  usagePercent: { color: colors.text, fontSize: 11.5, fontWeight: "700" },
  usageTrack: { height: 7, borderRadius: 4, overflow: "hidden", backgroundColor: colors.panelStrong },
  usageFill: { height: "100%", backgroundColor: colors.a1 },
  usageNote: { color: colors.dim, fontSize: 11.5 },
});
