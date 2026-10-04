/* Known agents: live status dots and forget-offline-agent, same rules as
   the desktop (the server refuses to forget a connected agent). */

import React, { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Link, Stack } from "expo-router";
import { Bot, ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import { useAgents, useForgetAgent, type AgentInfo } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { AgentAvatar } from "../../src/components/AgentAvatar";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toastErr } from "../../src/components/Toast";
import { fmtTs } from "@agora/core";
import { control, typography, weight, layout, radii, space } from "../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../src/lib/useTheme";
import { useSession } from "../../src/state/session";

export default function AgentsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const agents = useAgents();
  const forget = useForgetAgent();
  const admin = useSession((s) => s.instanceAdmin);
  const adminKnown = useSession((s) => s.instanceAdminKnown);
  const onlineCount = (agents.data ?? []).filter((agent) => agent.live).length;

  return (
    <>
      <Stack.Screen
        options={{
          title: "Agents",
          headerShown: true,
          headerRight: admin
            ? () => (
                <Link href="/(app)/add-agent" asChild>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add agent"
                    style={styles.addHeader}
                  >
                    <Plus size={18} color={colors.a1} />
                    <Text style={styles.addHeaderText}>Add</Text>
                  </Pressable>
                </Link>
              )
            : undefined,
        }}
      />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={agents.isRefetching}
            onRefresh={() => void agents.refetch()}
            tintColor={colors.dim}
          />
        }
      >
        {agents.isSuccess && agents.data.length > 0 ? <View style={styles.summary}>
          <View style={[styles.dot, onlineCount > 0 ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.summaryText}>{onlineCount} online</Text>
          <Text style={styles.summaryTotal}>{agents.data.length} {agents.data.length === 1 ? "agent" : "agents"}</Text>
        </View> : null}
        {agents.isPending ? <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Loading agents">
          <ActivityIndicator color={colors.a1} />
          <Text style={styles.meta}>Loading agents…</Text>
        </View> : null}
        {agents.isError ? <EmptyState icon={Bot} title="Couldn't refresh agents"
          description="Check your connection and try again."
          action={{ label: "Try again", onPress: () => void agents.refetch(), disabled: agents.isFetching }} /> : null}
        {(agents.data ?? []).map((a) => (
          <AgentCard key={a.id} agent={a} onForget={() =>
                  forget.mutate(a.id, {
                    onError: (e) => toastErr("Forget failed", e),
                  })
          } />
        ))}
        {agents.isSuccess && agents.data.length === 0 ? (
          <EmptyState icon={Bot} title="No agents yet" description={!adminKnown
              ? "Checking whether you can add agents…"
              : admin
                ? "No agents yet. Use Add agent to connect one; it will appear here when it dials in."
                : "No agents are available yet. Ask an instance admin to connect one."} />
        ) : null}
        {admin ? (
          <Link href="/(app)/add-agent" asChild>
            <Pressable style={styles.addCard} accessibilityRole="button">
              <View style={styles.addMark}><Plus size={20} color={colors.a2} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.addTitle}>Add an agent</Text>
                <Text style={styles.meta}>
                  Connect a coding agent, integration, or Pantheo instance.
                </Text>
              </View>
              <ChevronRight size={18} color={colors.faint} />
            </Pressable>
          </Link>
        ) : null}
      </ScrollView>
    </>
  );
}

function AgentCard({ agent, onForget }: { agent: AgentInfo; onForget: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.card}>
    <View style={styles.row}>
      <AgentAvatar agentId={agent.id} size={44} />
      <View style={styles.identity}>
        <Text style={styles.name}>{agent.name}</Text>
        <Text style={styles.meta}>{agent.requires_mention ? "Responds when mentioned" : "Responds to all messages"}</Text>
      </View>
    </View>
    <View style={styles.cardFooter}>
      <View style={styles.status}>
        <View style={[styles.dot, agent.live ? styles.dotOn : styles.dotOff]} />
        <Text style={[styles.meta, agent.live && styles.online]}>{agent.live ? "Online" : "Offline"}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Connection details for ${agent.name}`}
        accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.detailsToggle, pressed && styles.pressed]}>
        <Text style={styles.meta}>Details</Text>
        {expanded ? <ChevronDown size={16} color={colors.faint} /> : <ChevronRight size={16} color={colors.faint} />}
      </Pressable>
    </View>
    {expanded ? <View style={styles.details}>
      <Text style={styles.detailLabel}>CONNECTION SOURCE</Text>
      <Text selectable style={styles.meta}>{agent.source}</Text>
      <Text style={styles.detailLabel}>AGENT ID</Text>
      <Text selectable style={styles.meta}>{agent.id}</Text>
    </View> : null}
    {!agent.live ? <View style={styles.offlineActions}>
      <Text style={[styles.meta, styles.identity]}>Last seen {fmtTs(agent.last_seen)}</Text>
      <ArmedButton label="Forget" accessibilityLabel={`Forget ${agent.name}`} onConfirm={onForget} />
    </View> : null}
  </View>;
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: layout.gutter, gap: space.md, paddingBottom: layout.contentBottom },
  summary: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, marginBottom: space.sm },
  summaryText: { ...typography.meta, color: colors.a2 },
  summaryTotal: { ...typography.caption, color: colors.faint, flex: 1, textAlign: "right" },
  loading: { alignItems: "center", gap: space.md, padding: space.section },
  identity: { flex: 1, gap: space.xs },
  status: { flexDirection: "row", alignItems: "center", gap: space.sm },
  online: { color: colors.a2 },
  card: { ...surfaces.card, paddingHorizontal: space.lg, paddingTop: space.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  cardFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm },
  detailsToggle: { minHeight: control.minTouchSize, paddingLeft: space.md, flexDirection: "row", gap: space.xs, alignItems: "center" },
  details: { borderTopWidth: 1, borderTopColor: colors.border, gap: space.xs, paddingBottom: space.lg },
  detailLabel: { ...typography.eyebrow, color: colors.faint, marginTop: space.md },
  offlineActions: { flexDirection: "row", alignItems: "center", gap: space.md, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: space.md },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotOn: { backgroundColor: colors.green },
  dotOff: { backgroundColor: colors.faint },
  name: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold },
  meta: { ...typography.caption, color: colors.dim },
  addHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    minHeight: control.minTouchSize,
    paddingHorizontal: space.md,
  },
  addHeaderText: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  addCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: radii.lg,
    padding: space.lg,
    minHeight: 66,
  },
  addMark: { width: 40, height: 40, borderRadius: radii.md, backgroundColor: colors.mintSoft, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.65 },
  addTitle: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold },
}));
