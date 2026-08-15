import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router } from "expo-router";
import { ChevronRight, Search, User } from "lucide-react-native";
import { useAllMemberships, useMe, useUsers } from "@agora/core";
import { Icon } from "../../src/components/Icon";
import { colors } from "../../src/lib/theme";

export default function PeopleScreen() {
  const me = useMe();
  const isInstanceAdmin = me.data?.instance_admin === true;
  const users = useUsers(isInstanceAdmin);
  const memberships = useAllMemberships(isInstanceAdmin);
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const membership of memberships.data ?? []) {
      result.set(membership.member_id, (result.get(membership.member_id) ?? 0) + 1);
    }
    return result;
  }, [memberships.data]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (users.data ?? []).filter(user => !needle ||
      `${user.display_name} ${user.username}`.toLowerCase().includes(needle));
  }, [query, users.data]);

  if (me.isSuccess && !isInstanceAdmin) return <>
    <Stack.Screen options={{ title: "People", headerShown: true }} />
    <View style={[styles.root, styles.content]}><Text style={styles.hint}>Instance admin access required.</Text></View>
  </>;

  return <>
    <Stack.Screen options={{ title: "People", headerShown: true }} />
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>Select a person to view and manage their access.</Text>
      <View style={styles.searchBox}>
        <Icon icon={Search} size={18} color={colors.faint} />
        <TextInput accessibilityLabel="Search people" placeholder="Search people" placeholderTextColor={colors.faint}
          style={styles.searchInput} value={query} onChangeText={setQuery} autoCapitalize="none" />
      </View>
      {filtered.map(user => <Pressable key={user.username} style={styles.card} onPress={() => router.push({
        pathname: "/(app)/people/[username]", params: { username: user.username },
      })}>
        <View style={styles.avatar}><Icon icon={User} size={20} color={colors.text} /></View>
        <View style={styles.details}>
          <Text style={styles.name}>{user.display_name || user.username}</Text>
          <Text style={styles.username}>@{user.username}{user.instance_role === "admin" ? " · instance admin" : ""}</Text>
          <Text style={styles.accessCount}>{counts.get(user.username) ?? 0} access {(counts.get(user.username) ?? 0) === 1 ? "entry" : "entries"}</Text>
        </View>
        <Icon icon={ChevronRight} size={18} color={colors.faint} />
      </Pressable>)}
      {users.isSuccess && filtered.length === 0 ? <Text style={styles.empty}>No people match your search.</Text> : null}
    </ScrollView>
  </>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg }, content: { padding: 16, gap: 10, paddingBottom: 40 },
  hint: { color: colors.dim, fontSize: 13, lineHeight: 19, marginBottom: 2 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panel, borderRadius: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 11 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderRadius: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.panelStrong, alignItems: "center", justifyContent: "center" },
  details: { flex: 1, gap: 2 }, name: { color: colors.text, fontWeight: "700", fontSize: 15 },
  username: { color: colors.dim, fontSize: 12 }, accessCount: { color: colors.faint, fontSize: 12, marginTop: 2 },
  empty: { color: colors.faint, textAlign: "center", paddingVertical: 24 },
});
