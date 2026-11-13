/* "Resolve all" for one approvals card (swipe left on it): answers every
   request the sheet lists in that channel or thread with one choice. The
   list is loaded when the sheet opens and only those ids are sent, so a
   request arriving meanwhile stays pending. */

import React from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, CheckCheck, X, type LucideIcon } from "lucide-react-native";
import {
  APPROVAL_BULK_LABELS, approvalAlwaysScope, approvalBulkResultText, approvalRequestText, approvalBulkSummary, useConversationApprovals, useResolveApprovals,
  type ApprovalBulkAction, type ApprovalItem,
} from "@agora/core";
import { previewText } from "../lib/previewText";
import { typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { Icon } from "./Icon";
import { SheetHeader } from "./SheetHeader";
import { toast, toastErr } from "./Toast";

const ICONS: Record<ApprovalBulkAction, LucideIcon> = { approve: Check, always: CheckCheck, reject: X };

export function ResolveApprovalsSheet({ item, onClose }: { item: ApprovalItem; onClose: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const pending = useConversationApprovals(item.channel_id, item.thread_id);
  const resolve = useResolveApprovals();
  const summary = approvalBulkSummary(pending.data ?? []);
  // Shown in the sheet too: while it is open a toast draws underneath it.
  const [failure, setFailure] = React.useState("");
  // One request at a time (isPending lags a render behind a quick double
  // tap), and a result that lands after this sheet closed only reports: it
  // must not close a sheet opened since for another card.
  const busy = React.useRef(false);
  const open = React.useRef(true);
  React.useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  const where = item.kind === "thread" ? `${previewText(item.title || "Thread")} in #${item.channel_name}` : `#${item.channel_name}`;
  const choose = (action: ApprovalBulkAction) => {
    const ids = summary.ids[action];
    if (!ids.length || busy.current) return;
    busy.current = true;
    setFailure("");
    // The promise settles even if the sheet was closed meanwhile (per-call
    // mutate callbacks would not), so the outcome is always reported.
    resolve.mutateAsync({ channelId: item.channel_id, threadId: item.thread_id, ids, action }).then(result => {
      toast(approvalBulkResultText(result), result.failed ? "warn" : undefined);
      if (open.current) onClose();
    }, error => {
      busy.current = false;
      if (open.current) setFailure(`Resolve all failed: ${(error as Error).message}`);
      toastErr("Resolve all failed", error);
    });
  };
  const detail = (action: ApprovalBulkAction) => {
    const n = summary.ids[action].length;
    if (!n) return "None of these offer it";
    const count = `${n} ${n === 1 ? "request" : "requests"}`;
    const scope = approvalAlwaysScope(summary);
    if (action !== "always" || !scope) return count;
    return `${count} · stops asking about ${scope} for this agent session`;
  };
  const count = pending.data?.length ?? 0;
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.backdrop} onPress={onClose}>
        <Pressable accessible={false} accessibilityViewIsModal style={styles.sheet} onPress={event => event.stopPropagation()}>
          <SheetHeader title="Resolve all" onClose={onClose} />
          <Text style={styles.where} numberOfLines={2}>{where}</Text>
          {pending.isLoading ? <ActivityIndicator color={colors.dim} style={styles.loading} />
            : pending.isError ? <Pressable accessibilityRole="button" onPress={() => void pending.refetch()}>
              <Text style={styles.error}>Couldn't load the requests. Tap to retry.</Text>
            </Pressable>
            : <>
              <Text style={styles.lead}>{count === 1 ? "1 pending request" : `${count} pending requests`}{summary.manual
                ? ` · ${summary.manual} ${summary.manual === 1 ? "needs" : "need"} answering one by one` : ""}</Text>
              {/* Every request the choice answers, by name (scrolls when long):
                  never approve unseen requests. */}
              <ScrollView style={styles.listScroll} contentContainerStyle={styles.list} nestedScrollEnabled>
                {(pending.data ?? []).map(request =>
                  <Text key={request.id} style={styles.request}>
                    <Text style={styles.requestAuthor}>{request.author_name}: </Text>{approvalRequestText(request.text)}
                  </Text>)}
              </ScrollView>
              {(["approve", "always", "reject"] as const).map(action => {
                const disabled = !summary.ids[action].length || resolve.isPending;
                return <Pressable key={action} accessibilityRole="button" accessibilityState={{ disabled }}
                  accessibilityLabel={`${APPROVAL_BULK_LABELS[action]}, ${detail(action)}`} disabled={disabled}
                  style={[styles.row, disabled && styles.disabled]} onPress={() => choose(action)}>
                  <Icon icon={ICONS[action]} size={20} color={action === "reject" ? colors.red : colors.text} />
                  <View style={styles.rowText}>
                    <Text style={[styles.label, action === "reject" && styles.danger]}>{APPROVAL_BULK_LABELS[action]}</Text>
                    <Text style={styles.detail}>{detail(action)}</Text>
                  </View>
                </Pressable>;
              })}
              {failure ? <Text style={styles.error} accessibilityRole="alert">{failure}</Text> : null}
              {resolve.isPending ? <ActivityIndicator color={colors.dim} /> : null}
            </>}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, gap: 6, paddingBottom: 34 },
  where: { color: colors.dim, fontSize: typography.bodySm.fontSize },
  lead: { color: colors.text, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold, marginVertical: 4 },
  loading: { marginVertical: 24 },
  listScroll: { maxHeight: 260, marginBottom: 6 },
  list: { gap: 4 },
  request: { color: colors.dim, fontSize: typography.caption.fontSize },
  requestAuthor: { color: colors.text, fontWeight: weight.semibold },
  error: { color: colors.red, fontSize: typography.bodySm.fontSize, marginVertical: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowText: { flex: 1, gap: 2, paddingVertical: 8 },
  label: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.semibold },
  danger: { color: colors.red },
  detail: { color: colors.dim, fontSize: typography.caption.fontSize },
  disabled: { opacity: 0.45 },
}));
