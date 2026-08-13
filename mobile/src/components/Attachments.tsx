/* Message attachments: inline previews for images (fetched with the auth
   header), tap-to-download-and-share for everything else. */

import React, { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useEventListener } from "expo";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
// The legacy API is the one with documented header support on downloads.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { FileText } from "lucide-react-native";
import { authHeaders, fileUrl, type Session } from "@agora/core";
import type { Attachment } from "@agora/core";
import { fmtSize } from "@agora/core";
import { colors } from "../lib/theme";
import { Icon } from "./Icon";
import { toastErr } from "./Toast";
import { ImagePreviewModal } from "./ImagePreviewModal";

export async function downloadAndShare(session: Session, att: Attachment) {
  const target = `${FileSystem.cacheDirectory}${att.id}-${att.filename}`;
  const res = await FileSystem.downloadAsync(fileUrl(session, att.id), target, {
    headers: authHeaders(session),
  });
  if (res.status !== 200) throw new Error(`download failed (${res.status})`);
  await Sharing.shareAsync(res.uri, { mimeType: att.mime || undefined });
}

function FileChip({ session, att }: { session: Session; att: Attachment }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      style={styles.chip}
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await downloadAndShare(session, att);
        } catch (e) {
          toastErr("Download failed", e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <ActivityIndicator size="small" color={colors.dim} /> : <Icon icon={FileText} size={16} />}
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {att.filename}
        </Text>
        <Text style={styles.size}>{fmtSize(att.size)}</Text>
      </View>
    </Pressable>
  );
}

const NATIVE_VIDEO = /^video\/(mp4|quicktime|webm)(?:;|$)/i;

export function VideoAttachment({ session, att, onError }: {
  session: Session; att: Attachment; onError: () => void;
}) {
  const player = useVideoPlayer({ uri: fileUrl(session, att.id), headers: authHeaders(session) });
  useEventListener(player, "statusChange", ({ status }) => { if (status === "error") onError(); });
  return <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />;
}

export function Attachments({
  session,
  attachments,
  imageSource,
}: {
  session: Session;
  attachments: Attachment[];
  /** Story/testing seam for deterministic inline images; production omits it. */
  imageSource?: (attachment: Attachment) => { uri: string; headers?: Record<string, string> };
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [failedVideos, setFailedVideos] = useState<Set<string>>(new Set());
  const images = React.useMemo(() => attachments.filter(att => att.mime.startsWith("image/")), [attachments]);
  const previewIndex = previewId === null ? -1 : images.findIndex(image => image.id === previewId);
  React.useEffect(() => {
    if (previewId !== null && previewIndex < 0) setPreviewId(null);
  }, [previewId, previewIndex]);
  if (!attachments || attachments.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {attachments.map((att) => {
        const source = imageSource?.(att) ?? {
              uri: fileUrl(session, att.id),
              headers: authHeaders(session),
            };
        return att.mime.startsWith("image/") ? (
          <Pressable key={att.id} accessibilityRole="button" style={{ alignSelf: "flex-start" }}
            accessibilityLabel={`Preview ${att.filename}`}
            onPress={() => setPreviewId(att.id)}>
            <Image source={source} style={styles.image} contentFit="cover" transition={100} />
          </Pressable>
        ) : NATIVE_VIDEO.test(att.mime) && !failedVideos.has(att.id)
          && !(Platform.OS === "ios" && att.mime.toLowerCase().startsWith("video/webm")) ? (
          <VideoAttachment key={att.id} session={session} att={att}
            onError={() => setFailedVideos(current => new Set(current).add(att.id))} />
        ) : (
          <FileChip key={att.id} session={session} att={att} />
        );
      })}
      {previewIndex >= 0 ? (
        <ImagePreviewModal
          source={imageSource?.(images[previewIndex]) ?? {
            uri: fileUrl(session, images[previewIndex].id),
            headers: authHeaders(session),
          }}
          filename={images[previewIndex].filename}
          index={previewIndex}
          total={images.length}
          onPrevious={() => setPreviewId(images[Math.max(0, previewIndex - 1)].id)}
          onNext={() => setPreviewId(images[Math.min(images.length - 1, previewIndex + 1)].id)}
          onClose={() => setPreviewId(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 6 },
  image: {
    width: 220,
    height: 160,
    borderRadius: 10,
    backgroundColor: colors.panelStrong,
  },
  video: { width: 300, height: 210, borderRadius: 10, backgroundColor: "#000" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    maxWidth: 260,
  },
  name: { color: colors.text, fontSize: 13, fontWeight: "600" },
  size: { color: colors.dim, fontSize: 11.5 },
});
