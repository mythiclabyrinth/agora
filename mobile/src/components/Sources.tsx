/* Cited sources, mirroring the desktop's chips + viewer: a message whose
   meta carries `sources` renders them as a numbered chip row instead of raw
   URLs (the trailing "Sources:" block is cut from the text at
   meta.sources_start; the stored text itself is never rewritten). Tapping a
   chip opens a bottom sheet that pages through the sources one by one —
   swipe or arrows — with whatever the server has unfurled for each. */

import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronLeft, ChevronRight, ExternalLink, Link2, X } from "lucide-react-native";
import { Image } from "expo-image";
import type { LinkPreview, Message } from "@agora/core";
import { openLink } from "../lib/openLink";
import { colors, mono, surfaces } from "../lib/theme";
import { Icon } from "./Icon";

/* The text a bubble renders: cut a server-detected trailing sources block
   (meta.sources_start is a UTF-16 offset — exactly what String.slice
   counts) and let the chips stand in. */
export function visibleText(message: Message): string {
  const meta = message.meta;
  const cut = meta?.sources_start;
  if (
    meta?.sources?.length &&
    typeof cut === "number" &&
    Number.isInteger(cut) &&
    cut > 0 &&
    cut < message.text.length
  ) {
    return message.text.slice(0, cut).replace(/\s+$/, "");
  }
  return message.text;
}

/* Hermes' URL support is spotty; a regex host is all the chips need. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, "") : "";
}

export function Sources({ message }: { message: Message }) {
  const sources = message.meta?.sources ?? [];
  const [open, setOpen] = React.useState<number | null>(null);
  if (!sources.length) return null;
  return (
    <View style={styles.chips}>
      {sources.map((s, i) => (
        <Pressable key={i} style={styles.chip} onPress={() => setOpen(i)} hitSlop={4}>
          <View style={styles.chipNum}>
            <Text style={styles.chipNumText}>{i + 1}</Text>
          </View>
          <Text style={styles.chipLabel} numberOfLines={1}>
            {s.title || hostOf(s.url) || s.url}
          </Text>
        </Pressable>
      ))}
      {open != null ? (
        <SourceViewer sources={sources} initial={open} onClose={() => setOpen(null)} />
      ) : null}
    </View>
  );
}

function SourceViewer({
  sources,
  initial,
  onClose,
}: {
  sources: LinkPreview[];
  initial: number;
  onClose: () => void;
}) {
  const [width, setWidth] = React.useState(0);
  const [index, setIndex] = React.useState(initial);
  const scroller = React.useRef<ScrollView>(null);
  React.useEffect(() => {
    if (width > 0) scroller.current?.scrollTo({ x: initial * width, animated: false });
    // Only the first layout positions the pager; swipes take over from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);
  const go = (k: number) => {
    const next = (k + sources.length) % sources.length;
    scroller.current?.scrollTo({ x: next * width, animated: true });
    setIndex(next);
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* A Pressable sheet swallows taps so only the backdrop closes. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.top}>
            <Text style={styles.count}>
              Source {index + 1} of {sources.length}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon icon={X} size={18} color={colors.dim} />
            </Pressable>
          </View>
          <View style={styles.pagerBox} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
            {width > 0 ? (
              <ScrollView
                ref={scroller}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(e) =>
                  setIndex(
                    Math.max(
                      0,
                      Math.min(
                        sources.length - 1,
                        Math.round(e.nativeEvent.contentOffset.x / width),
                      ),
                    ),
                  )
                }
              >
                {sources.map((s, i) => (
                  <SourceCard key={i} source={s} width={width} />
                ))}
              </ScrollView>
            ) : null}
          </View>
          <View style={styles.nav}>
            <Pressable onPress={() => go(index - 1)} hitSlop={8} disabled={sources.length < 2}>
              <Icon icon={ChevronLeft} size={20} color={sources.length < 2 ? colors.faint : colors.dim} />
            </Pressable>
            <View style={styles.dots}>
              {sources.map((_, i) => (
                <View key={i} style={[styles.dot, i === index && styles.dotOn]} />
              ))}
            </View>
            <Pressable onPress={() => go(index + 1)} hitSlop={8} disabled={sources.length < 2}>
              <Icon icon={ChevronRight} size={20} color={sources.length < 2 ? colors.faint : colors.dim} />
            </Pressable>
          </View>
          <Pressable style={styles.openBtn} onPress={() => void openLink(sources[index].url)}>
            <Icon icon={ExternalLink} size={15} color={colors.text} />
            <Text style={styles.openText}>Open source</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SourceCard({ source, width }: { source: LinkPreview; width: number }) {
  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={styles.card}
      showsVerticalScrollIndicator={false}
    >
      {source.image ? (
        <Image source={{ uri: source.image }} style={styles.cardImg} contentFit="cover" transition={80} />
      ) : null}
      <View style={styles.siteRow}>
        <Icon icon={Link2} size={12} color={colors.dim} />
        <Text style={styles.site} numberOfLines={1}>
          {source.site || hostOf(source.url) || "link"}
        </Text>
      </View>
      <Text style={styles.title}>{source.title || hostOf(source.url) || source.url}</Text>
      {source.description ? <Text style={styles.desc}>{source.description}</Text> : null}
      <Text style={styles.url} numberOfLines={1}>
        {source.url}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 200,
    paddingVertical: 3,
    paddingLeft: 4,
    paddingRight: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panelStrong,
  },
  chipNum: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chipNumText: { color: colors.dim, fontSize: 10, fontWeight: "700" },
  chipLabel: { color: colors.dim, fontSize: 11.5, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: {
    ...surfaces.sheet,
    paddingBottom: 34,
    gap: 12,
  },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  count: {
    color: colors.faint,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  pagerBox: { minHeight: 150, maxHeight: 360 },
  card: { gap: 8, paddingBottom: 4 },
  cardImg: {
    width: "100%",
    height: 160,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  siteRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  site: { color: colors.dim, fontSize: 12, flexShrink: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  desc: { color: colors.dim, fontSize: 13, lineHeight: 19 },
  url: { ...mono, color: colors.faint, fontSize: 11 },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  dots: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 5,
    flexShrink: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.14)" },
  dotOn: { backgroundColor: colors.a2 },
  openBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panelStrong,
  },
  openText: { color: colors.text, fontSize: 13.5, fontWeight: "600" },
});
