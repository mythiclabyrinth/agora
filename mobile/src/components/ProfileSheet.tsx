/* Profile card opened by tapping a message author's avatar: an agent's
   picture plus everything /api/agents knows about it (home connection, live
   status, last seen, mention requirement), or a person's account details
   from /api/users. Same bottom-sheet pattern as the channel screen's
   MessageActions. */

import React from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
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

export function ProfileSheet({ message, onClose }: { message: Message; onClose: () => void }) {
  const isAgent = message.author_type === "agent";
  const agents = useAgents();
  const users = useUsers(!isAgent);
  const usageQuery = useAgentUsage(isAgent ? message.author_id : "");
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
              <Row
                k="Responds"
                v={
                  agent.requires_mention
                    ? "Only when @-mentioned"
                    : "To every message in its channels"
                }
              />
              <AgentUsageBlock data={usageQuery.data} live={agent.live} />
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

function AgentUsageBlock({ data, live }: { data: ReturnType<typeof useAgentUsage>["data"]; live: boolean }) {
  const usage = data?.usage;
  if (!usage) return <Text style={styles.usageNote}>Usage has not been reported by this agent.</Text>;
  if (usage.availability === "external") {
    return (
      <View style={styles.usageCard}>
        <Text style={styles.usageTitle}>USAGE</Text>
        <Text style={styles.usageNote}>Cursor reports usage in its dashboard.</Text>
        {usage.external_url ? <Pressable onPress={() => void Linking.openURL(usage.external_url!)}><Text style={styles.usageLink}>Open usage dashboard</Text></Pressable> : null}
      </View>
    );
  }
  return (
    <View style={styles.usageCard}>
      <View style={styles.usageHeading}><Text style={styles.usageTitle}>USAGE{usage.plan ? ` · ${usage.plan.toUpperCase()}` : ""}</Text><Text style={styles.usageNote}>{data?.refreshing ? "Updating…" : !live ? "Agent offline" : data?.stale ? "May be outdated" : "Current"}</Text></View>
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
  usageLink: { color: colors.a1, fontSize: 12.5, fontWeight: "700" },
});
