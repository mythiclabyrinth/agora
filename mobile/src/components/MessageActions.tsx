import React, { useEffect, useState } from "react";
import {
  Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  Copy, Info, Link, Maximize2, MessageCircle, Minimize2, Pencil, Pin, Star, Trash2, Volume2,
  type LucideIcon,
} from "lucide-react-native";
import {
  FEATURES, tldrOf, useDeleteMessage, useEditMessage, useGroups, useLatestReply, usePinMessage,
  useStarMessage, useTldrView,
  type Message,
} from "@agora/core";
import { beginReviewUiBlock, endReviewUiBlock } from "../lib/storeReview";
import { colors } from "../lib/theme";
import { copyDeepLink } from "../lib/deepLinks";
import { speakMessage } from "../lib/nativeSpeech";
import { Icon } from "./Icon";
import { QuickReactions } from "./Reactions";
import { toastErr } from "./Toast";

export function MessageActions({
  message, channelId, groupId, starred, pinned = false, canPin, canEdit, canDelete,
  onClose, onReact, onThread, onDeleted,
}: {
  message: Message;
  channelId: string;
  groupId?: string;
  starred: boolean;
  pinned?: boolean;
  canPin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
  onReact: () => void;
  onThread?: () => void;
  onDeleted?: () => void;
}) {
  const star = useStarMessage(channelId);
  const pin = usePinMessage(channelId);
  const del = useDeleteMessage();
  const edit = useEditMessage();
  const toggleTldr = useTldrView((s) => s.toggle);
  const showingTldr = useTldrView((s) => !!s.showing[message.id]);
  const [editing, setEditing] = useState(false);
  const [showingInfo, setShowingInfo] = useState(false);
  const [text, setText] = useState(message.text);
  const isRoot = message.thread_id == null;
  const hasReplies = isRoot && (message.reply_count ?? 0) > 0;
  const latestReply = useLatestReply(message.channel_id, message.id, showingInfo && hasReplies);
  const groups = useGroups().data || [];
  const channelName = groups.flatMap(group => group.channels || [])
    .find(channel => channel.id === message.channel_id)?.name || channelId;
  const hasText = !!message.text.trim();
  const act = (fn: () => void) => { fn(); onClose(); };
  useEffect(() => {
    beginReviewUiBlock();
    return () => endReviewUiBlock();
  }, []);
  const confirmDelete = () => Alert.alert(
    "Delete message?",
    isRoot && (message.reply_count ?? 0) > 0
      ? "This deletes the message and its whole thread for everyone."
      : "This deletes the message for everyone.",
    [
      { text: "Cancel", style: "cancel", onPress: onClose },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          await del.mutateAsync({ message });
          onDeleted?.();
        } catch (e) {
          toastErr("Delete failed", e);
        } finally {
          onClose();
        }
      } },
    ],
  );

  if (showingInfo) {
    const reactions = (message.reactions || []).reduce((sum, reaction) => sum + reaction.users.length, 0);
    const details: Array<[string, string]> = [
      ["Sent", absoluteTime(message.ts)],
      ["Author", `${message.author_name || message.author_id} · ${message.author_type === "agent" ? "agent" : "person"}`],
      ["Channel", `#${channelName}`],
    ];
    if (message.meta?.edited_at) details.push(["Edited", absoluteTime(message.meta.edited_at)]);
    if (isRoot && message.alias?.trim()) details.push(["Thread name", message.alias.trim()]);
    if (hasReplies) details.push(["Replies", String(message.reply_count)]);
    if (message.attachments.length) details.push(["Attachments", String(message.attachments.length)]);
    if (reactions) details.push(["Reactions", String(reactions)]);
    return (
      <Modal transparent animationType="fade" onRequestClose={() => setShowingInfo(false)}>
        <Pressable style={styles.infoBackdrop} onPress={() => setShowingInfo(false)}>
          <Pressable style={styles.infoPanel} onPress={(event) => event.stopPropagation()}>
            <View style={styles.infoHead}>
              <Text accessibilityRole="header" style={styles.title}>Message info</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close message info"
                style={styles.close} onPress={() => setShowingInfo(false)}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            <ScrollView>
              {details.map(([label, value]) => <InfoRow key={label} label={label} value={value} />)}
              {hasReplies ? <InfoRow label="Latest reply" value={latestReply.isLoading
                ? "Loading…"
                : latestReply.data
                  ? `${absoluteTime(latestReply.data.ts)} · ${latestReply.data.author_name || latestReply.data.author_id}`
                  : "Unavailable"} /> : null}
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Message ID</Text>
                <View style={styles.infoId}>
                  <Text selectable style={styles.infoValue}>{message.id}</Text>
                  {groupId ? <Pressable onPress={() => void copyDeepLink({
                    kind: "message", groupId, channelId: message.channel_id,
                    threadId: message.thread_id, messageId: message.id,
                  }, "Message")}><Text style={styles.infoLink}>Copy link</Text></Pressable> : null}
                </View>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  if (editing) {
    return (
      <Modal transparent animationType="fade" onRequestClose={() => { setText(message.text); setEditing(false); }}>
        <KeyboardAvoidingView style={styles.keyboard}
          behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.editor}>
            <Text style={styles.title}>Edit message</Text>
            <TextInput
              accessibilityLabel="Edit message"
              style={styles.input}
              value={text}
              onChangeText={setText}
              multiline
              autoFocus
              textAlignVertical="top"
            />
            <View style={styles.editorActions}>
              <Pressable style={styles.editorBtn} disabled={edit.isPending}
                onPress={() => { setText(message.text); setEditing(false); }}>
                <Text style={styles.text}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.editorBtn, styles.save]}
                disabled={!text.trim() || edit.isPending}
                onPress={() => edit.mutate({ message, text: text.trim() }, {
                  onSuccess: onClose,
                  onError: (e) => toastErr("Edit failed", e),
                })}
              >
                <Text style={styles.saveText}>{edit.isPending ? "Saving…" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <QuickReactions message={message} onDone={onClose} onMore={onReact} />
          {tldrOf(message) != null ? <Row icon={showingTldr ? Maximize2 : Minimize2}
            label={showingTldr ? "Show full message" : "Show TL;DR"}
            onPress={() => act(() => toggleTldr(message.id))} /> : null}
          {onThread ? <Row icon={MessageCircle} label="Reply in thread" onPress={() => act(onThread)} /> : null}
          <Row icon={Info} label="Info" onPress={() => setShowingInfo(true)} />
          {hasText ? <Row icon={Copy} label="Copy" onPress={() => act(() => {
            void Clipboard.setStringAsync(message.text).catch((e) => toastErr("Copy failed", e));
          })} /> : null}
          {groupId ? <Row icon={Link} label="Copy link" onPress={() => act(() => {
            void copyDeepLink({
              kind: "message", groupId, channelId: message.channel_id,
              threadId: message.thread_id, messageId: message.id,
            }, "Message");
          })} /> : null}
          {canEdit && hasText ? <Row icon={Pencil} label="Edit"
            onPress={() => { setText(message.text); setEditing(true); }} /> : null}
          {Platform.OS === "ios" && hasText ? <Row icon={Volume2} label="Speak" onPress={() => act(() => {
            void speakMessage(message, (e) => toastErr("Speak failed", e)).catch((e) => toastErr("Speak failed", e));
          })} /> : null}
          {FEATURES.stars ? <Row icon={Star} label={starred ? "Unstar" : "Star"} color={starred ? colors.amber : colors.text}
            fill={starred ? colors.amber : "none"} onPress={() => act(() => star.mutate(
              { messageId: message.id, starred: !starred }, { onError: (e) => toastErr("Star failed", e) },
            ))} /> : null}
          {isRoot && canPin ? <Row icon={Pin} label={pinned ? "Unpin" : "Pin"} color={pinned ? colors.a1 : colors.text}
            onPress={() => act(() => pin.mutate(
              { messageId: message.id, pinned: !pinned }, { onError: (e) => toastErr("Pin failed", e) },
            ))} /> : null}
          {canDelete ? <Row icon={Trash2} label="Delete" color={colors.red} danger onPress={confirmDelete} /> : null}
        </View>
      </Pressable>
    </Modal>
  );
}

function absoluteTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "medium",
  }).format(new Date(ts * 1000));
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue}>{value}</Text>
  </View>;
}

function Row({ icon, label, onPress, color = colors.text, fill, danger = false }: {
  icon: LucideIcon; label: string; onPress: () => void; color?: string; fill?: string; danger?: boolean;
}) {
  return <Pressable style={styles.row} onPress={onPress}>
    <Icon icon={icon} size={18} color={color} fill={fill} />
    <Text style={[styles.text, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  keyboard: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.sheet, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, gap: 4, paddingBottom: 34 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  text: { color: colors.text, fontSize: 15.5 }, danger: { color: colors.red },
  editor: { backgroundColor: colors.sheet, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 34, gap: 12 },
  title: { color: colors.text, fontSize: 17, fontWeight: "800" },
  input: { minHeight: 150, maxHeight: 360, borderWidth: 1, borderColor: colors.a1, borderRadius: 10, padding: 12, color: colors.text, backgroundColor: colors.bg, fontSize: 15, lineHeight: 21 },
  editorActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  editorBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 9 },
  save: { backgroundColor: colors.accent }, saveText: { color: colors.onAccent, fontWeight: "800" },
  infoBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", padding: 20 },
  infoPanel: { maxHeight: "82%", backgroundColor: colors.sheet, borderRadius: 16, overflow: "hidden" },
  infoHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  close: { paddingHorizontal: 8, paddingVertical: 5 }, closeText: { color: colors.a1, fontSize: 14, fontWeight: "700" },
  infoRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  infoLabel: { color: colors.faint, fontSize: 11.5, fontWeight: "700" },
  infoValue: { color: colors.text, fontSize: 14, lineHeight: 20 },
  infoId: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  infoLink: { color: colors.a1, fontSize: 14, fontWeight: "700" },
});
