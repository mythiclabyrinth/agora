import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { User } from "lucide-react-native";
import { useAllMemberships, useMe, useUsers } from "@agora/core";
import { Icon } from "../../src/components/Icon";
import { colors } from "../../src/lib/theme";

export default function PeopleScreen() {
  const me = useMe();
  const isInstanceAdmin = me.data?.instance_admin === true;
  const users = useUsers(isInstanceAdmin);
  const memberships = useAllMemberships(isInstanceAdmin);
  const byUser = useMemo(() => {
    const result = new Map<string, NonNullable<typeof memberships.data>>();
    for (const membership of memberships.data ?? []) {
      const rows = result.get(membership.member_id) ?? [];
      rows.push(membership);
      result.set(membership.member_id, rows);
    }
    return result;
  }, [memberships.data]);

  if (me.isSuccess && !isInstanceAdmin) return <>
    <Stack.Screen options={{ title: "People", headerShown: true }} />
    <View style={[styles.root, styles.content]}>
      <Text style={styles.hint}>Instance admin access required.</Text>
    </View>
  </>;

  return <>
    <Stack.Screen options={{ title: "People", headerShown: true }} />
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>All people on this Agora instance and their group or channel access.</Text>
      {(users.data ?? []).map(user => <View key={user.username} style={styles.card}>
        <Icon icon={User} size={22} color={colors.text} />
        <View style={styles.details}>
          <Text style={styles.name}>{user.display_name || user.username}</Text>
          <Text style={styles.username}>{user.username}{user.instance_role === "admin" ? " · instance admin" : ""}</Text>
          {(byUser.get(user.username) ?? []).map((membership, index) =>
            <Text key={`${membership.group_id}-${membership.channel_id ?? "group"}-${index}`} style={styles.access}>
              {membership.group_name} · {membership.channel_name ? `#${membership.channel_name}` : "whole group"} · {membership.role}
            </Text>
          )}
          {!byUser.get(user.username)?.length ? <Text style={styles.empty}>No group access</Text> : null}
        </View>
      </View>)}
    </ScrollView>
  </>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg }, content: { padding: 14, gap: 10, paddingBottom: 40 },
  hint: { color: colors.dim, fontSize: 13, marginBottom: 4 }, card: { flexDirection: "row", gap: 12, padding: 14, borderRadius: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  details: { flex: 1, gap: 3 }, name: { color: colors.text, fontWeight: "700", fontSize: 15 }, username: { color: colors.dim, fontSize: 12 },
  access: { color: colors.text, fontSize: 12, marginTop: 3 }, empty: { color: colors.faint, fontSize: 12, marginTop: 3 },
});
