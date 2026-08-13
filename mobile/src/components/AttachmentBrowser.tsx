import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Download, FileText, MessageSquare, Trash2 } from "lucide-react-native";
import {
  authHeaders,
  fileUrl,
  fmtSize,
  fmtTs,
  useAttachments,
  useDeleteAttachment,
  type AttachmentBrowserItem,
  type Session,
} from "@agora/core";
import { colors } from "../lib/theme";
import { downloadAndShare } from "./Attachments";
import { Icon } from "./Icon";
import { toastErr } from "./Toast";

export function AttachmentBrowser({
  channelId,
  threadId,
  session,
  onOpenMessage,
  imageSource,
}: {
  channelId: string;
  threadId: number | null;
  session: Session;
  onOpenMessage: (item: AttachmentBrowserItem) => void;
  /** Native Storybook/testing seam; production loads authenticated file URLs. */
  imageSource?: (item: AttachmentBrowserItem) => { uri: string; headers?: Record<string, string> };
}) {
  const query = useAttachments(channelId, threadId);
  const remove = useDeleteAttachment(channelId, threadId);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  const download = async (item: AttachmentBrowserItem) => {
    setDownloading(item.id);
    try { await downloadAndShare(session, item); }
    catch (error) { toastErr("Download failed", error); }
    finally { setDownloading(null); }
  };
  const confirmDelete = (item: AttachmentBrowserItem) => Alert.alert(
    "Delete attachment?",
    `${item.filename} will be removed from Agora for everyone.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        setDeleting(item.id);
        remove.mutate(item.id, {
          onError: (error) => toastErr("Delete failed", error),
          onSettled: () => setDeleting(null),
        });
      } },
    ],
  );

  if (query.isLoading) return <View style={styles.center}><ActivityIndicator color={colors.a1} /></View>;
  if (query.isError) return (
    <View style={styles.center}>
      <Text style={styles.empty}>Couldn’t load attachments.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry attachments" onPress={() => query.refetch()}>
        <Text style={styles.retry}>Retry</Text>
      </Pressable>
    </View>
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={items.length ? styles.list : styles.emptyList}
      refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => query.refetch()} tintColor={colors.a1} />}
      onEndReached={() => { if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage(); }}
      onEndReachedThreshold={0.35}
      ListEmptyComponent={<Text style={styles.empty}>No attachments yet.</Text>}
      ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator style={styles.footer} color={colors.a1} /> : null}
      renderItem={({ item }) => {
        const isImage = item.mime?.startsWith("image/") && !failed.has(item.id);
        return (
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Jump to ${item.filename}`} style={styles.main} onPress={() => onOpenMessage(item)}>
              <View style={styles.preview}>
                {isImage ? <Image
                  source={imageSource?.(item) ?? { uri: fileUrl(session, item.id), headers: authHeaders(session) }}
                  style={styles.image}
                  contentFit="cover"
                  onError={() => setFailed((current) => new Set(current).add(item.id))}
                /> : <Icon icon={FileText} size={25} color={colors.a1} />}
              </View>
              <View style={styles.details}>
                <Text style={styles.filename} numberOfLines={1}>{item.filename}</Text>
                <Text style={styles.meta} numberOfLines={1}>{fmtSize(item.size)} · {item.author_name || item.author_id} · {fmtTs(item.ts)}</Text>
                {threadId == null && item.thread_name ? (
                  <View style={styles.thread}><Icon icon={MessageSquare} size={13} /><Text style={styles.threadText} numberOfLines={1}>{item.thread_name}</Text></View>
                ) : null}
              </View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Download ${item.filename}`} hitSlop={8} disabled={downloading === item.id} onPress={() => void download(item)}>
              {downloading === item.id ? <ActivityIndicator size="small" color={colors.dim} /> : <Icon icon={Download} size={19} />}
            </Pressable>
            {item.can_delete ? <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${item.filename}`} hitSlop={8} disabled={deleting === item.id} onPress={() => confirmDelete(item)}>
              {deleting === item.id ? <ActivityIndicator size="small" color={colors.dim} /> : <Icon icon={Trash2} size={19} />}
            </Pressable> : null}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  list: { padding: 14, gap: 10 },
  emptyList: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  row: { minHeight: 78, flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, backgroundColor: colors.panel },
  main: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 },
  preview: { width: 58, height: 54, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 10, backgroundColor: colors.panelStrong },
  image: { width: "100%", height: "100%" },
  details: { flex: 1, minWidth: 0, gap: 3 },
  filename: { color: colors.text, fontSize: 15, fontWeight: "600" },
  meta: { color: colors.dim, fontSize: 12 },
  thread: { flexDirection: "row", alignItems: "center", gap: 5 },
  threadText: { flexShrink: 1, color: colors.dim, fontSize: 12 },
  empty: { color: colors.dim, textAlign: "center" },
  retry: { color: colors.a1, fontWeight: "600" },
  footer: { padding: 18 },
});
