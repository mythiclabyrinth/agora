/* Known agents: live status dots and forget-offline-agent, same rules as
   the desktop (the server refuses to forget a connected agent). */

import React from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, Stack } from "expo-router";
import { Bot, Plus } from "lucide-react-native";
import { useAgents, useForgetAgent } from "@agora/core";
import { EmptyState } from "../../src/components/EmptyState";
import { AgentAvatar } from "../../src/components/AgentAvatar";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toastErr } from "../../src/components/Toast";
import { fmtTs } from "@agora/core";
import { colors, typography, weight } from "../../src/lib/theme";
import { useSession } from "../../src/state/session";

export default function AgentsScreen() {
  const agents = useAgents();
  const forget = useForgetAgent();
  const admin = useSession((s) => s.instanceAdmin);
  const adminKnown = useSession((s) => s.instanceAdminKnown);

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
                    hitSlop={10}
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
        {(agents.data ?? []).map((a) => (
          <View key={a.id} style={styles.rowWrap}>
          <View style={styles.row}>
            <AgentAvatar agentId={a.id} size={30} />
            <View style={[styles.dot, a.live ? styles.dotOn : styles.dotOff]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{a.name}</Text>
              <Text style={styles.meta}>
                {a.source}
                {a.requires_mention ? " · mention-only" : ""}
                {a.live ? " · online" : ` · last seen ${fmtTs(a.last_seen)}`}
              </Text>
            </View>
            {!a.live ? (
              <ArmedButton
                label="Forget"
                onConfirm={() =>
                  forget.mutate(a.id, {
                    onError: (e) => toastErr("Forget failed", e),
                  })
                }
              />
            ) : null}
          </View>
          </View>
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
              <Plus size={20} color={colors.a2} />
              <View style={{ flex: 1 }}>
                <Text style={styles.addTitle}>Add an agent</Text>
                <Text style={styles.meta}>
                  Connect a coding agent, integration, or Pantheo instance.
                </Text>
              </View>
            </Pressable>
          </Link>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 8, paddingBottom: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowWrap: { backgroundColor: colors.panel, borderRadius: 12 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotOn: { backgroundColor: colors.green },
  dotOff: { backgroundColor: colors.faint },
  name: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold },
  meta: { color: colors.dim, fontSize: typography.caption.fontSize },
  empty: {
    color: colors.dim,
    textAlign: "center",
    paddingVertical: 24,
    lineHeight: 20,
  },
  addHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minHeight: 40,
  },
  addHeaderText: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  addCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "rgba(56,225,200,0.22)",
    backgroundColor: "rgba(56,225,200,0.06)",
    borderRadius: 14,
    padding: 14,
    minHeight: 66,
  },
  addTitle: { color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.bold },
});
