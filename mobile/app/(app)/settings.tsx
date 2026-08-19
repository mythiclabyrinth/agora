/* Account, server session, and app settings. Agent administration has one
   dedicated surface, linked here for instance admins. */

import React, { useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Application from "expo-application";
import { Link, Stack } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEBSITE_URL, keys, useApi } from "@agora/core";
import type { Me } from "@agora/core";
import { ArmedButton } from "../../src/components/ArmedButton";
import { LinkPreferences } from "../../src/components/LinkPreferences";
import { toast, toastErr } from "../../src/components/Toast";
import { compareVersions, lookupStoreVersion } from "../../src/lib/appVersion";
import { openLink } from "../../src/lib/openLink";
import { openWriteReviewUrl } from "../../src/lib/storeReview";
import { colors } from "../../src/lib/theme";
import { usePrefs } from "../../src/state/prefs";
import { useSession } from "../../src/state/session";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/* Profile self-service: edit how your name appears on new messages.
   Saving PATCHes /api/me and updates the local session state. */
function DisplayNameRow() {
  const api = useApi();
  const queryClient = useQueryClient();
  const username = useSession((s) => s.username);
  const displayName = useSession((s) => s.displayName);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const me = await api.patch<Me>("/api/me", { display_name: text.trim() });
      useSession.setState({ displayName: me.display_name || username });
      await queryClient.invalidateQueries({ queryKey: keys.me });
      setEditing(false);
      toast("Display name updated");
    } catch (e) {
      toastErr("Couldn't update your name", e as Error);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{displayName || username}</Text>
          <Text style={styles.meta}>
            How your name appears on new messages.
          </Text>
        </View>
        <Pressable
          style={styles.linkBtn}
          onPress={() => {
            setText(displayName || username);
            setEditing(true);
          }}
        >
          <Text style={styles.linkBtnText}>Edit</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <TextInput
        style={[styles.input, { flex: 1 }]}
        value={text}
        onChangeText={setText}
        placeholder={username}
        placeholderTextColor={colors.faint}
        autoFocus
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      <Pressable style={styles.linkBtn} onPress={() => setEditing(false)}>
        <Text style={styles.linkBtnDim}>Cancel</Text>
      </Pressable>
      <Pressable
        style={styles.linkBtn}
        onPress={() => void save()}
        disabled={saving}
      >
        <Text style={[styles.linkBtnText, saving && { opacity: 0.4 }]}>
          {saving ? "Saving…" : "Save"}
        </Text>
      </Pressable>
    </View>
  );
}

export default function SettingsScreen() {
  const api = useApi();
  const session = useSession((s) => s.session)!;
  const signOut = useSession((s) => s.signOut);
  const forgetServer = useSession((s) => s.forgetServer);
  const instanceAdmin = useSession((s) => s.instanceAdmin);
  const preferNativeApps = usePrefs((s) => s.preferNativeApps);
  const linkBrowser = usePrefs((s) => s.linkBrowser);
  const setPreferNativeApps = usePrefs((s) => s.setPreferNativeApps);
  const setLinkBrowser = usePrefs((s) => s.setLinkBrowser);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<Me>("/api/me"),
  });
  // Connections & pairing are operator surfaces; members never see them.
  const [deleting, setDeleting] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const appVersion = Application.nativeApplicationVersion ?? "0.0.0";
  const appBuild = Application.nativeBuildVersion ?? "?";

  // App Store apps can't self-update; the best we can do is compare against
  // the published store version and deep-link to the listing. Pre-publish
  // (no listing yet) reads as "up to date" on purpose.
  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    try {
      const bundleId = Application.applicationId ?? "app.agora.mobile";
      const listing = await lookupStoreVersion(bundleId);
      if (listing && compareVersions(listing.version, appVersion) > 0) {
        Alert.alert(
          "Update available",
          `Version ${listing.version} is available (you have ${appVersion}).`,
          [
            { text: "Later", style: "cancel" },
            ...(listing.url
              ? [
                  {
                    text: "Open App Store",
                    // Preserve the OS-level App Store handoff instead of applying
                    // the user's browser fallback preference to this system link.
                    onPress: () => void Linking.openURL(listing.url),
                  },
                ]
              : []),
          ],
        );
      } else {
        toast("You're on the latest version");
      }
    } catch (e) {
      toastErr("Couldn't check for updates", e as Error);
    } finally {
      setCheckingUpdate(false);
    }
  };

  // App Store guideline 5.1.1(v): account deletion must be reachable in-app.
  // The server wipes everything keyed to this user and revokes all sessions;
  // we then drop the stored credentials, landing back on onboarding.
  const deleteAccount = () => {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your messages, attachments, stars and read " +
        "history from this server, and signs you out on every device. " +
        "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await api.delete("/api/me");
              await forgetServer();
            } catch (e) {
              toastErr("Delete failed", e as Error);
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {instanceAdmin ? (
          <Link href="/(app)/add-agent" asChild>
            <Pressable style={styles.agentHub} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={styles.agentHubTitle}>Agents & connections</Text>
                <Text style={styles.meta}>
                  Guided setup for coding agents, integrations, and Pantheo.
                </Text>
              </View>
              <Text style={styles.agentHubArrow}>›</Text>
            </Pressable>
          </Link>
        ) : null}
        {instanceAdmin ? (
          <Link href="/(app)/instance-ai" asChild>
            <Pressable style={styles.agentHub} accessibilityRole="button">
              <View style={{ flex: 1 }}>
                <Text style={styles.agentHubTitle}>Instance settings</Text>
                <Text style={styles.meta}>
                  Voice, Ask AI providers, and credentials for this Agora.
                </Text>
              </View>
              <Text style={styles.agentHubArrow}>›</Text>
            </Pressable>
          </Link>
        ) : null}
        <Section title="Session">
          <DisplayNameRow />
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{session.baseUrl}</Text>
              <Text style={styles.meta}>
                {me.data
                  ? `signed in as ${me.data.display_name || me.data.username}` +
                    `${me.data.instance_admin ? " (admin)" : ""} · server v${me.data.version}`
                  : me.isError
                    ? "server unreachable"
                    : "…"}
              </Text>
            </View>
            {/* Sign out keeps the server; next launch asks only to sign in. */}
            <ArmedButton label="Sign out" onConfirm={() => void signOut()} />
          </View>
          {/* Switching instances forgets the URL too — full onboarding next time. */}
          <View style={styles.row}>
            <Text style={[styles.meta, { flex: 1 }]}>
              Connect this app to a different Agora server.
            </Text>
            <ArmedButton
              label="Switch server"
              onConfirm={() => void forgetServer()}
            />
          </View>
          <View style={styles.row}>
            <Text style={[styles.meta, { flex: 1 }]}>
              Permanently delete your data on this server and sign out
              everywhere.
            </Text>
            <Pressable
              style={styles.linkBtn}
              onPress={deleteAccount}
              disabled={deleting}
            >
              <Text style={[styles.deleteText, deleting && { opacity: 0.4 }]}>
                {deleting ? "Deleting…" : "Delete account"}
              </Text>
            </Pressable>
          </View>
        </Section>

        <Section title="Links">
          <LinkPreferences
            preferNativeApps={preferNativeApps}
            browser={linkBrowser}
            onPreferNativeAppsChange={setPreferNativeApps}
            onBrowserChange={setLinkBrowser}
          />
        </Section>

        <Section title="About">
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                Agora {appVersion} (build {appBuild})
              </Text>
            </View>
            <Pressable
              style={styles.linkBtn}
              onPress={checkForUpdates}
              disabled={checkingUpdate}
            >
              <Text
                style={[styles.linkBtnText, checkingUpdate && { opacity: 0.4 }]}
              >
                {checkingUpdate ? "Checking…" : "Check for updates"}
              </Text>
            </Pressable>
          </View>
          {/* App Review expects the policy/support pages to be reachable in-app. */}
          <View style={styles.row}>
            <Pressable
              style={styles.linkBtn}
              onPress={() =>
                void openLink(
                  "https://tomjose92.github.io/agora/privacy.html",
                )
              }
            >
              <Text style={styles.linkBtnText}>Privacy policy</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              style={styles.linkBtn}
              onPress={() => void openLink(WEBSITE_URL)}
            >
              <Text style={styles.linkBtnText}>Website</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              style={styles.linkBtn}
              onPress={() =>
                void openLink("https://tomjose92.github.io/agora/")
              }
            >
              <Text style={styles.linkBtnText}>Support</Text>
            </Pressable>
          </View>
          {/* Direct App Store write-review URL — never requestReview() from a
              tap; Apple's guidelines forbid that and it silently no-ops. */}
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>Enjoying Agora?</Text>
              <Text style={styles.meta}>
                Ratings help invited teammates find the right app in the store.
              </Text>
            </View>
            <Pressable
              style={styles.linkBtn}
              accessibilityRole="link"
              accessibilityLabel="Rate Agora on the App Store"
              onPress={() => void openWriteReviewUrl()}
            >
              <Text style={styles.linkBtnText}>Rate Agora</Text>
            </Pressable>
          </View>
        </Section>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 20, paddingBottom: 40 },
  section: { gap: 8 },
  sectionTitle: {
    color: colors.dim,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  name: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.dim, fontSize: 12 },
  input: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  linkBtn: { paddingVertical: 10, alignItems: "center" },
  linkBtnText: { color: colors.a1, fontSize: 14, fontWeight: "700" },
  linkBtnDim: { color: colors.dim, fontSize: 14, fontWeight: "600" },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: "700" },
  agentHub: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 72,
    padding: 15,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(56,225,200,0.22)",
    backgroundColor: "rgba(56,225,200,0.06)",
  },
  agentHubTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 3,
  },
  agentHubArrow: { color: colors.a2, fontSize: 28, lineHeight: 30 },
});
