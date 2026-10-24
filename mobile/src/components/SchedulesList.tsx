/* Scheduled messages for a channel, a thread, or (in the inbox) every
   channel the viewer can access. People only manage them here — pause,
   resume, cancel, retime. Creating a schedule or changing its words is done
   by asking an agent, which acts for that person; the server enforces that
   split, so this screen simply never offers a create or text-edit path. */

import React, { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { CalendarClock, Clock, MessageSquare, Pause, Play, Trash2 } from "lucide-react-native";
import {
  describeSchedule,
  fmtTs,
  intervalParts,
  intervalSeconds,
  LOST_ACCESS_NOTE,
  lostChannelAccess,
  nextRunsLabel,
  sortSchedules,
  useCancelSchedule,
  useSchedules,
  useUpdateSchedule,
  type IntervalUnit,
  type Schedule,
  type ScheduleSpec,
} from "@agora/core";
import { radii, space, typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { ResponsiveText as Text } from "./ResponsiveText";
import { SheetHeader } from "./SheetHeader";
import { ThemedInput } from "./ThemedInput";
import { toastErr } from "./Toast";

const STATUS_LABEL: Record<Schedule["status"], string> = {
  active: "Active", paused: "Paused", done: "Done", cancelled: "Cancelled",
};

const EMPTY_TITLE = "No schedules yet.";
const EMPTY_DESCRIPTION = "Ask an agent to schedule a message here. It posts as you at the time you choose.";

/** Pause/resume and cancel for one schedule, with failures toasted. Busy is
    tracked per row: overlapping actions on two rows must not clear each
    other's spinner (or re-enable a row whose request is still running). */
export function useScheduleActions() {
  const update = useUpdateSchedule();
  const cancel = useCancelSchedule();
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const start = (id: string) => setBusyIds(prev => new Set(prev).add(id));
  const finish = (id: string) => setBusyIds(prev => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  const isBusy = (id: string) => busyIds.has(id);
  const setStatus = (item: Schedule, status: "paused" | "active") => {
    start(item.id);
    update.mutate({ id: item.id, change: { status } }, {
      onError: error => toastErr(status === "paused" ? "Pause failed" : "Resume failed", error),
      onSettled: () => finish(item.id),
    });
  };
  const confirmCancel = (item: Schedule) => Alert.alert(
    "Cancel schedule?",
    "It stops posting and leaves this list. An agent can create a new one later.",
    [
      { text: "Keep", style: "cancel" },
      { text: "Cancel schedule", style: "destructive", onPress: () => {
        start(item.id);
        cancel.mutate({ id: item.id, channel_id: item.channel_id }, {
          onError: error => toastErr("Cancel failed", error),
          onSettled: () => finish(item.id),
        });
      } },
    ],
  );
  return { isBusy, setStatus, confirmCancel };
}

export function ScheduleRow({ item, showThread, showChannel = false, onOpen, onEdit, actions }: {
  item: Schedule;
  /** Label the thread a schedule posts into (channel and inbox views). */
  showThread: boolean;
  /** Label the channel too (inbox view groups by channel, so off by default). */
  showChannel?: boolean;
  onOpen?: (item: Schedule) => void;
  onEdit: (item: Schedule) => void;
  actions: ReturnType<typeof useScheduleActions>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const busy = actions.isBusy(item.id);
  const manageable = item.can_manage === true && (item.status === "active" || item.status === "paused");
  // The owner lost the channel: keep only Cancel, nothing that would post
  // into a conversation they can no longer see.
  const lostAccess = lostChannelAccess(item);
  const cadence = describeSchedule(item.schedule);
  const where = [showChannel && item.channel_name ? `# ${item.channel_name}` : null, showThread ? item.thread_title : null]
    .filter(Boolean).join(" · ");
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open scheduled message: ${cadence}`}
        disabled={!onOpen} style={styles.main} onPress={() => onOpen?.(item)}>
        <View style={styles.top}>
          <Icon icon={CalendarClock} size={16} color={colors.accentText} />
          <Text style={styles.cadence} numberOfLines={2}>{cadence}</Text>
          <View style={[styles.chip, item.status === "paused" && styles.chipPaused]}>
            <Text maxFontSizeMultiplier={1.3} style={[styles.chipText, item.status === "paused" && styles.chipTextPaused]}>{STATUS_LABEL[item.status]}</Text>
          </View>
        </View>
        <Text style={styles.text} numberOfLines={2}>{item.text}</Text>
        {where ? <View style={styles.thread}><Icon icon={MessageSquare} size={13} /><Text style={styles.meta} numberOfLines={1}>{where}</Text></View> : null}
        {(item.status === "active" || item.status === "paused") && item.next_runs.length ? (
          <Text style={styles.meta} numberOfLines={2}>{nextRunsLabel(item.status)} {item.next_runs.map(ts => fmtTs(ts)).join(" · ")}</Text>
        ) : null}
        <Text style={styles.meta} numberOfLines={1}>
          {item.owner_name || item.owner}{item.via_agent ? ` · via ${item.via_agent}` : ""}
        </Text>
        {item.last_error ? <Text style={styles.error} numberOfLines={3}>{item.last_error}</Text> : null}
        {lostAccess ? <Text style={styles.error} numberOfLines={2}>{LOST_ACCESS_NOTE}</Text> : null}
      </Pressable>
      {manageable && lostAccess ? (
        <View style={styles.actions}>
          {busy ? <ActivityIndicator size="small" color={colors.dim} /> : (
            <Pressable accessibilityRole="button" accessibilityLabel={`Cancel schedule: ${cadence}`} hitSlop={10} onPress={() => actions.confirmCancel(item)}>
              <Icon icon={Trash2} size={19} />
            </Pressable>
          )}
        </View>
      ) : manageable ? (
        <View style={styles.actions}>
          {busy ? <ActivityIndicator size="small" color={colors.dim} /> : <>
            <Pressable accessibilityRole="button" accessibilityLabel={`Change time: ${cadence}`} hitSlop={10} onPress={() => onEdit(item)}>
              <Icon icon={Clock} size={19} />
            </Pressable>
            {item.status === "active" ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Pause schedule: ${cadence}`} hitSlop={10} onPress={() => actions.setStatus(item, "paused")}>
                <Icon icon={Pause} size={19} />
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel={`Resume schedule: ${cadence}`} hitSlop={10} onPress={() => actions.setStatus(item, "active")}>
                <Icon icon={Play} size={19} />
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel={`Cancel schedule: ${cadence}`} hitSlop={10} onPress={() => actions.confirmCancel(item)}>
              <Icon icon={Trash2} size={19} />
            </Pressable>
          </>}
        </View>
      ) : null}
    </View>
  );
}

type Mode = "once" | "interval" | "cron";
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-25 07:00" in the viewer's local time. */
export function formatLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse "YYYY-MM-DD HH:MM" as local time; null when malformed. */
export function parseLocalInput(value: string): number | null {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h) return null;
  return Math.floor(date.getTime() / 1000);
}

/** The spec the editor would save, or an error to show instead. */
export function editedSpec(mode: Mode, fields: { once: string; count: string; unit: IntervalUnit; cron: string }):
  { spec: ScheduleSpec } | { error: string } {
  if (mode === "once") {
    const at = parseLocalInput(fields.once);
    return at == null ? { error: "Use the format 2026-10-25 07:00 (your local time)." } : { spec: { kind: "once", at } };
  }
  if (mode === "interval") {
    const count = Number(fields.count);
    if (!Number.isInteger(count) || count < 1) return { error: "Enter a whole number." };
    const seconds = intervalSeconds(count, fields.unit);
    return seconds < 300 ? { error: "The shortest gap is 5 minutes." } : { spec: { kind: "interval", seconds } };
  }
  const expr = fields.cron.trim().replace(/\s+/g, " ");
  return expr.split(" ").length === 5 ? { spec: { kind: "cron", expr } } : { error: "A cron rule has 5 fields, e.g. 0 7 * * 1-5 (UTC)." };
}

/** The optional next-run override for a repeating schedule: none when the
    field is empty, else a future time or an error to show. */
export function nextRunChange(mode: Mode, value: string, nowSeconds = Date.now() / 1000):
  { run_at: number } | { error: string } | null {
  if (mode === "once" || !value.trim()) return null;
  const at = parseLocalInput(value);
  if (at == null) return { error: "Use the format 2026-10-25 07:00 for the next run (your local time)." };
  return at <= nowSeconds ? { error: "The next run must be in the future." } : { run_at: at };
}

export function ScheduleTimeSheet({ item, onClose }: { item: Schedule | null; onClose: () => void }) {
  const styles = useStyles();
  const { colors } = useAppTheme();
  const update = useUpdateSchedule();
  const initial = item?.schedule;
  const [mode, setMode] = useState<Mode>(initial?.kind ?? "once");
  const parts = initial?.kind === "interval" ? intervalParts(initial.seconds) : { count: 1, unit: "hours" as IntervalUnit };
  // Posts go out in the owner's name, so only the owner changes how often;
  // an admin managing someone else's schedule edits just the next time.
  const timeOnly = item?.is_owner === false;
  const [once, setOnce] = useState(formatLocalInput(item?.run_at ?? (initial?.kind === "once" ? initial.at : Math.floor(Date.now() / 1000) + 3600)));
  const [count, setCount] = useState(String(parts.count));
  const [unit, setUnit] = useState<IntervalUnit>(parts.unit);
  const [cron, setCron] = useState(initial?.kind === "cron" ? initial.expr : "0 7 * * *");
  // Optional for a repeating schedule: move its next run without touching
  // the rule. Left empty, the server keeps or derives the next run.
  const [nextAt, setNextAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!item) return null;
  const draft = editedSpec(timeOnly ? "once" : mode, { once, count, unit, cron });
  const save = () => {
    if ("error" in draft) { setError(draft.error); return; }
    const next = nextRunChange(timeOnly ? "once" : mode, nextAt);
    if (next && "error" in next) { setError(next.error); return; }
    setError(null);
    const change = timeOnly && draft.spec.kind === "once"
      ? { run_at: draft.spec.at }
      : next ? { schedule: draft.spec, run_at: next.run_at } : { schedule: draft.spec };
    update.mutate({ id: item.id, change }, {
      onSuccess: onClose,
      // The server validates cron rules and limits; show its words in place.
      onError: e => setError(e instanceof Error ? e.message : String(e)),
    });
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.backdrop} onPress={onClose}>
        <Pressable accessibilityViewIsModal accessible={false} style={styles.sheet} onPress={event => event.stopPropagation()}>
          <SheetHeader title="Change time" onClose={onClose} />
          {timeOnly ? null : <View style={styles.modes} accessibilityRole="tablist">
            {(["once", "interval", "cron"] as const).map(option => (
              <Pressable key={option} accessibilityRole="tab" accessibilityState={{ selected: mode === option }}
                accessibilityLabel={option === "once" ? "Once" : option === "interval" ? "Every" : "Cron rule"}
                style={[styles.mode, mode === option && styles.modeActive]} onPress={() => { setMode(option); setError(null); }}>
                <Text style={[styles.modeText, mode === option && styles.modeTextActive]}>
                  {option === "once" ? "Once" : option === "interval" ? "Every" : "Cron"}
                </Text>
              </Pressable>
            ))}
          </View>}
          {timeOnly || mode === "once" ? (
            <ThemedInput accessibilityLabel="Date and time" value={once} onChangeText={setOnce} autoCapitalize="none"
              autoCorrect={false} placeholder="2026-10-25 07:00" />
          ) : mode === "interval" ? (
            <View style={styles.intervalRow}>
              <ThemedInput accessibilityLabel="Every how many" style={styles.count} value={count} onChangeText={setCount} keyboardType="number-pad" />
              {([...(parts.unit === "seconds" ? ["seconds"] as const : []), "minutes", "hours", "days"] as const).map(option => (
                <Pressable key={option} accessibilityRole="button" accessibilityLabel={option} accessibilityState={{ selected: unit === option }}
                  style={[styles.unit, unit === option && styles.modeActive]} onPress={() => setUnit(option)}>
                  <Text style={[styles.modeText, unit === option && styles.modeTextActive]}>{option}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <ThemedInput accessibilityLabel="Cron rule" value={cron} onChangeText={setCron} autoCapitalize="none"
              autoCorrect={false} placeholder="0 7 * * 1-5" />
          )}
          {!timeOnly && mode !== "once" ? (
            <ThemedInput accessibilityLabel="Next run" value={nextAt} onChangeText={setNextAt} autoCapitalize="none"
              autoCorrect={false} placeholder="Next run (optional), 2026-10-25 07:00" />
          ) : null}
          <Text style={styles.hint}>
            {timeOnly
              ? `Next run, your local time. Only ${item.owner_name} can change how often it repeats.`
              : "spec" in draft
                ? describeSchedule(draft.spec) + (mode === "interval" && initial?.kind === "interval"
                  ? " · changing only the length keeps the next run unless it would be later than one new interval from now." : "")
                : mode === "once" ? "Your local time." : mode === "cron" ? "5-field cron rule, evaluated in UTC." : ""}
          </Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Save time" disabled={update.isPending}
            style={[styles.save, update.isPending && styles.disabled]} onPress={save}>
            {update.isPending ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveText}>Save</Text>}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Rows plus the shared editor and actions, for any list of schedules. */
export function ScheduleRows({ items, showThread, showChannel, onOpen, header, refreshing, onRefresh, empty }: {
  items: Schedule[];
  showThread: boolean;
  showChannel?: boolean;
  onOpen?: (item: Schedule) => void;
  header?: (item: Schedule, index: number, items: Schedule[]) => string | null;
  refreshing: boolean;
  onRefresh: () => void;
  empty: React.ReactElement;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const actions = useScheduleActions();
  const [editing, setEditing] = useState<Schedule | null>(null);
  return <>
    <FlatList
      data={items}
      keyExtractor={item => item.id}
      contentContainerStyle={items.length ? styles.list : styles.emptyList}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.a1} />}
      ListEmptyComponent={empty}
      renderItem={({ item, index }) => {
        const title = header?.(item, index, items) ?? null;
        return <View style={styles.group}>
          {title ? <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text> : null}
          <ScheduleRow item={item} showThread={showThread} showChannel={showChannel} onOpen={onOpen} onEdit={setEditing} actions={actions} />
        </View>;
      }}
    />
    {editing ? <ScheduleTimeSheet key={editing.id} item={editing} onClose={() => setEditing(null)} /> : null}
  </>;
}

export function SchedulesList({ channelId, threadId, onOpen }: {
  channelId: string;
  threadId: number | null;
  onOpen?: (item: Schedule) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const query = useSchedules(channelId, threadId);
  const items = useMemo(() => sortSchedules(query.data?.items ?? []), [query.data]);
  if (query.isLoading) return <View style={styles.center}><ActivityIndicator color={colors.a1} /></View>;
  if (query.isError) return (
    <EmptyState icon={CalendarClock} title="Couldn’t load schedules."
      action={{ label: "Retry", accessibilityLabel: "Retry schedules", onPress: () => void query.refetch() }} />
  );
  return <ScheduleRows items={items} showThread={threadId == null} onOpen={onOpen}
    refreshing={query.isRefetching} onRefresh={() => void query.refetch()}
    empty={<EmptyState icon={CalendarClock} title={EMPTY_TITLE} description={EMPTY_DESCRIPTION} />} />;
}

export const schedulesEmptyCopy = { title: EMPTY_TITLE, description: EMPTY_DESCRIPTION };

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  list: { padding: 14, gap: 10 },
  emptyList: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  group: { gap: 8 },
  groupTitle: { ...typography.caption, color: colors.dim, fontWeight: weight.semibold, marginTop: space.sm },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 12, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, backgroundColor: colors.panel },
  main: { flex: 1, minWidth: 0, gap: 4 },
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  cadence: { flex: 1, color: colors.text, fontSize: typography.message.fontSize, fontWeight: weight.semibold },
  chip: { borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: colors.accentSoft },
  chipPaused: { backgroundColor: colors.panelStrong },
  chipText: { ...typography.caption, color: colors.accentText, fontWeight: weight.semibold },
  chipTextPaused: { color: colors.dim },
  text: { color: colors.text, fontSize: typography.caption.fontSize },
  thread: { flexDirection: "row", alignItems: "center", gap: 5 },
  meta: { flexShrink: 1, color: colors.dim, fontSize: typography.caption.fontSize },
  error: { color: colors.red, fontSize: typography.caption.fontSize },
  actions: { flexDirection: "row", alignItems: "center", gap: 16, paddingTop: 2 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: { ...surfaces.sheet, gap: space.md, paddingBottom: space.xl },
  modes: { flexDirection: "row", gap: space.xs, padding: space.xs, borderRadius: radii.lg, backgroundColor: colors.panel },
  mode: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  modeActive: { backgroundColor: colors.accentSoft },
  modeText: { ...typography.bodySm, color: colors.dim, fontWeight: weight.semibold },
  modeTextActive: { color: colors.accentText },
  intervalRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  count: { width: 72 },
  unit: { minHeight: 40, paddingHorizontal: space.sm, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  hint: { ...typography.caption, color: colors.dim },
  save: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radii.md, backgroundColor: colors.a1 },
  saveText: { color: colors.onAccent, fontWeight: weight.semibold },
  disabled: { opacity: 0.6 },
}));
