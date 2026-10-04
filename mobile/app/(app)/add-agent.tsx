import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  AddAgentFlow,
  AgentConnectionsList,
} from "../../src/components/AgentConnections";

import { createThemedStyles, useAppTheme } from "../../src/lib/useTheme";
import { useSession } from "../../src/state/session";

type Tab = "connections" | "add";

export default function AddAgentScreen() {
  const styles = useStyles();
  const admin = useSession((s) => s.instanceAdmin);
  const adminKnown = useSession((s) => s.instanceAdminKnown);
  const loadSession = useSession((s) => s.load);
  const [tab, setTab] = useState<Tab>("add");
  return (
    <>
      <Stack.Screen
        options={{ title: "Agents & connections", headerShown: true }}
      />
      <SafeAreaView edges={["bottom"]} style={styles.root}>
        {!adminKnown ? (
          <View style={styles.denied}>
            <Text style={styles.deniedTitle}>Checking admin access…</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry checking admin access"
              style={styles.retry}
              onPress={() => void loadSession()}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : !admin ? (
          <View style={styles.denied}>
            <Text style={styles.deniedTitle}>Admin access required</Text>
            <Text style={styles.deniedCopy}>
              Only instance admins can create agent credentials or manage
              connections.
            </Text>
          </View>
        ) : (
          <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={92}
          >
            <View accessibilityRole="tablist" style={styles.tabs}>
              {(["connections", "add"] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === value }}
                  onPress={() => setTab(value)}
                  style={[styles.tab, tab === value && styles.tabActive]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      tab === value && styles.tabTextActive,
                    ]}
                  >
                    {value === "connections" ? "Connections" : "Add agent"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.content}
            >
              {tab === "connections" ? (
                <AgentConnectionsList />
              ) : (
                <AddAgentFlow onDone={() => setTab("connections")} />
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 14,
    marginTop: 8,
    padding: 4,
    borderRadius: 12,
    backgroundColor: colors.panelStrong,
  },
  tab: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  tabActive: { backgroundColor: colors.accentSoft },
  tabText: { color: colors.dim, fontSize: 13.5, fontWeight: "700" },
  tabTextActive: { color: colors.text },
  content: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    padding: 14,
    paddingBottom: 48,
  },
  denied: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 28,
  },
  deniedTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  deniedCopy: { color: colors.dim, textAlign: "center", lineHeight: 20 },
  retry: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  retryText: { color: colors.a1, fontSize: 14, fontWeight: "700" },
}));
