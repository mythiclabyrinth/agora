/* Inbox → Schedules: every schedule in channels the viewer can access (all
   channels for an admin; DMs stay owner-only on the server), grouped by
   channel with the same rows as the per-channel screen. */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { router } from "expo-router";
import { CalendarClock } from "lucide-react-native";
import {
  lostChannelAccess, scheduleChannelLabel, scheduleGroupName, sortSchedules, useAllDoneSchedules, useAllSchedules, useGroups, type Schedule,
  type ScheduleFilter,
} from "@agora/core";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { EmptyState } from "./EmptyState";
import { ScheduleRows, schedulesEmptyCopy } from "./SchedulesList";

const channelLabel = (item: Schedule) => item.channel_kind === "agent_dm" ? `DM · ${item.channel_name || "agent"}` : `# ${item.channel_name || item.channel_id}`;

/** Channel groups in name order; inside a group, the usual schedule order. */
export function groupSchedulesByChannel(items: Schedule[]): Schedule[] {
  const groups = new Map<string, Schedule[]>();
  for (const item of items) groups.set(item.channel_id, [...(groups.get(item.channel_id) ?? []), item]);
  return [...groups.values()]
    .sort((a, b) => channelLabel(a[0]).localeCompare(channelLabel(b[0])))
    .flatMap(group => sortSchedules(group));
}

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
  const groups = useGroups().data;
  // Done is one flat, latest-finished-first list: each row names its channel.
  const doneLabel = (item: Schedule) =>
    scheduleChannelLabel(item, scheduleGroupName(item, groups));
  const items = useMemo(() => groupSchedulesByChannel(query.data?.items ?? []), [query.data]);
  if (query.isLoading) return <View style={styles.center}><ActivityIndicator color={colors.dim} /></View>;
  if (query.isError) return (
    <EmptyState icon={CalendarClock} title="Couldn’t load schedules."
      action={{ label: "Retry", accessibilityLabel: "Retry schedules", onPress: () => void query.refetch() }} />
  );
  return <ScheduleRows items={items} done={done} doneLabel={doneLabel} filter={filter} onFilterChange={setFilter}
    showThread onOpen={openSchedule} truncated={!!query.data?.truncated}
    header={(item, index, all) => index === 0 || all[index - 1].channel_id !== item.channel_id ? channelLabel(item) : null}
    refreshing={query.isRefetching} onRefresh={() => void query.refetch()}
    empty={<EmptyState icon={CalendarClock} title={schedulesEmptyCopy.title} description={schedulesEmptyCopy.description} />} />;
}

const useStyles = createThemedStyles(() => ({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
}));
