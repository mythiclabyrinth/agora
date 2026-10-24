import React from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import type { Schedule } from "@agora/core";
import { SchedulesList } from "../../../src/components/SchedulesList";
import { createThemedStyles } from "../../../src/lib/useTheme";

export default function SchedulesScreen() {
  const styles = useStyles();
  const params = useLocalSearchParams<{ channelId: string; channelName?: string; groupId?: string; threadId?: string; threadName?: string }>();
  const threadId = params.threadId ? Number(params.threadId) : null;
  const open = (item: Schedule) => {
    if (item.thread_id != null) router.push({
      pathname: "/(app)/thread/[channelId]/[rootId]",
      params: { channelId: item.channel_id, rootId: String(item.thread_id), channelName: params.channelName, groupId: params.groupId },
    });
    else router.push({
      pathname: "/(app)/channel/[id]",
      params: { id: item.channel_id, name: params.channelName, groupId: params.groupId },
    });
  };
  return <View style={styles.root}>
    <Stack.Screen options={{ headerShown: true, title: threadId == null ? `Schedules · # ${params.channelName || "channel"}` : `Schedules · ${params.threadName || "this thread"}` }} />
    <SchedulesList channelId={params.channelId} threadId={threadId} onOpen={open} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => ({ root: { flex: 1, backgroundColor: colors.bg } }));
