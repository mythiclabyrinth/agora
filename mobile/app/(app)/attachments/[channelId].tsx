import React from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { View, StyleSheet } from "react-native";
import type { AttachmentBrowserItem } from "@agora/core";
import { AttachmentBrowser } from "../../../src/components/AttachmentBrowser";
import { colors } from "../../../src/lib/theme";
import { useSession } from "../../../src/state/session";

export default function AttachmentsScreen() {
  const params = useLocalSearchParams<{ channelId: string; channelName?: string; groupId?: string; threadId?: string; threadName?: string }>();
  const session = useSession((state) => state.session)!;
  const threadId = params.threadId ? Number(params.threadId) : null;
  const openMessage = (item: AttachmentBrowserItem) => {
    if (item.thread_id != null) router.push({
      pathname: "/(app)/thread/[channelId]/[rootId]",
      params: { channelId: params.channelId, rootId: String(item.thread_id), channelName: params.channelName, groupId: params.groupId, messageId: String(item.message_id) },
    });
    else router.push({
      pathname: "/(app)/channel/[id]",
      params: { id: params.channelId, name: params.channelName, groupId: params.groupId, messageId: String(item.message_id) },
    });
  };
  return <View style={styles.root}>
    <Stack.Screen options={{ headerShown: true, title: threadId == null ? `Attachments · # ${params.channelName || "channel"}` : `Attachments · ${params.threadName || "this thread"}` }} />
    <AttachmentBrowser channelId={params.channelId} threadId={threadId} session={session} onOpenMessage={openMessage} />
  </View>;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg } });
