/* Inbox → Schedules: every schedule in channels the viewer can access (all
   channels for an admin; DMs stay owner-only on the server), ordered by
   time with the same cards as the per-channel screen. */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { router } from "expo-router";
import { CalendarClock } from "lucide-react-native";
import {
  lostChannelAccess, sortSchedulesByTime, useAllDoneSchedules, useAllSchedules, type Schedule,
  type ScheduleFilter,
} from "@agora/core";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { EmptyState } from "./EmptyState";
import { ScheduleRows, schedulesEmptyCopy } from "./SchedulesList";

export function openSchedule(item: Schedule): void {
  // The owner was removed from that channel: there is nothing to open.
  if (lostChannelAccess(item)) return;
  if (item.thread_id != null) router.push({
    pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId: item.channel_id, rootId: String(item.thread_id), channelName: item.channel_name ?? undefined, groupId: item.group_id ?? undefined },
  });
  else router.push({
    pathname: "/(app)/channel/[id]",
    params: { id: item.channel_id, name: item.channel_name ?? undefined, groupId: item.group_id ?? undefined },
  });
}

export function SchedulesInbox() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const query = useAllSchedules();
  const [filter, setFilter] = useState<ScheduleFilter>("all");
  const done = useAllDoneSchedules(filter === "done");
  const items = useMemo(() => sortSchedulesByTime(query.data?.items ?? []), [query.data]);
  if (query.isLoading) return <View style={styles.center}><ActivityIndicator color={colors.dim} /></View>;
  if (query.isError) return (
    <EmptyState icon={CalendarClock} title="Couldn’t load schedules."
      action={{ label: "Retry", accessibilityLabel: "Retry schedules", onPress: () => void query.refetch() }} />
  );
  return <ScheduleRows items={items} done={done} filter={filter} onFilterChange={setFilter}
    onOpen={openSchedule} truncated={!!query.data?.truncated}
    refreshing={query.isRefetching} onRefresh={() => void query.refetch()}
    empty={<EmptyState icon={CalendarClock} title={schedulesEmptyCopy.title} description={schedulesEmptyCopy.description} />} />;
}

const useStyles = createThemedStyles(() => ({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
}));
