/* Long-press a link in a message: a Slack-style sheet naming the link, with
   Open in Browser, Copy Link and Share. Tapping the link still opens it the
   usual way (a supported app first); this sheet's Open always uses the
   browser chosen in Link preferences. */

import React from "react";
import { Modal, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ExternalLink, Link2, Share as ShareIcon, type LucideIcon } from "lucide-react-native";
import { openLinkOrThrow } from "../lib/openLink";
import { radii, typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";
import { Icon } from "./Icon";
import { toast, toastErr } from "./Toast";

export type LinkTarget = { text: string; url: string };

/** The modal's fade-out, after which another sheet may be presented. */
export const DISMISS_MS = 350;

/** The bold title: the link's own words, unless they are just the URL. */
export function linkSheetTitle(link: LinkTarget): string | null {
  const text = link.text.trim();
  return text && text !== link.url ? text : null;
}

export function LinkActionsSheet({ link, onClose }: { link: LinkTarget; onClose: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const title = linkSheetTitle(link);
  const act = (run: () => Promise<unknown>, failure: string, done?: string) => {
    onClose();
    // iOS refuses to present the share sheet or browser while this modal is
    // still fading out, so start once it has gone.
    setTimeout(() => {
      void run().then(() => { if (done) toast(done); }).catch((error) => toastErr(failure, error));
    }, DISMISS_MS);
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={styles.backdrop} onPress={onClose}>
        {/* A Pressable that swallows taps, so touching the title or URL
            (to read or select it) doesn't fall through and close the sheet. */}
        <Pressable accessible={false} accessibilityViewIsModal style={styles.sheet} onPress={event => event.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <View style={styles.badge}><Icon icon={Link2} size={18} color={colors.dim} /></View>
            <View style={styles.headText}>
              {title ? <Text style={styles.title} numberOfLines={2}>{title}</Text> : null}
              <Text style={title ? styles.url : styles.title} numberOfLines={3} selectable>{link.url}</Text>
            </View>
          </View>
          <View style={styles.divider} />
          <Row icon={ExternalLink} label="Open in Browser"
            onPress={() => act(() => openLinkOrThrow(link.url, { nativeApps: false }), "Couldn't open the link")} />
          <Row icon={Link2} label="Copy Link"
            onPress={() => act(async () => {
              if ((await Clipboard.setStringAsync(link.url)) === false) throw new Error("The clipboard didn't accept the link");
            }, "Copy failed", "Link copied.")} />
          <Row icon={ShareIcon} label="Share…"
            // iOS shares `url` (and would repeat it from `message`); Android only reads `message`.
            onPress={() => act(() => Share.share(Platform.OS === "ios" ? { url: link.url } : { message: link.url }), "Share failed")} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ icon, label, onPress }: { icon: LucideIcon; label: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} style={styles.row} onPress={onPress}>
    <Icon icon={icon} size={20} color={colors.text} />
    <Text style={styles.rowText}>{label}</Text>
  </Pressable>;
}

const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, gap: 2, paddingBottom: 34 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 6 },
  badge: { width: 40, height: 40, borderRadius: radii.md, backgroundColor: colors.panelStrong, alignItems: "center", justifyContent: "center" },
  headText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.bold },
  url: { color: colors.dim, fontSize: typography.bodySm.fontSize },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 48 },
  rowText: { color: colors.text, fontSize: typography.body.fontSize },
}));
