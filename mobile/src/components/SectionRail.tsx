/* Native conversation section navigation. The narrow, intentionally
   touch-capturing strip overlays a message list without reducing bubble
   width; long timelines use a fixed window instead of a nested scroller. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  conversationSections,
  agentRailColors,
  useAgents,
  type ConversationSection,
  type Message,
} from "@agora/core";
import { colors } from "../lib/theme";

export const MAX_VISIBLE_SECTION_DOTS = 12;
const SECTION_DOT_PITCH = 26;

export function agentDotStyle(color: string | undefined, selected: boolean) {
  if (!color) return undefined;
  return selected
    ? { backgroundColor: color }
    : { backgroundColor: "transparent", borderWidth: 1.5, borderColor: color, opacity: 1 };
}

export function sectionDotCapacity(height: number): number {
  return Math.min(
    MAX_VISIBLE_SECTION_DOTS,
    Math.max(2, Math.floor(height / SECTION_DOT_PITCH)),
  );
}

/** Keep a fixed-size, non-scrollable window around the active section. */
export function visibleSectionWindow<T>(
  items: T[],
  active: number,
  max = MAX_VISIBLE_SECTION_DOTS,
): T[] {
  if (items.length <= max) return items;
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(active - half, items.length - max));
  return items.slice(start, start + max);
}

export function activeSectionIndex(
  sections: ConversationSection[],
  messageId: number | null,
): number {
  if (!sections.length || messageId == null) return 0;
  let active = 0;
  for (let i = 1; i < sections.length; i += 1) {
    if (sections[i].mid > messageId) break;
    active = i;
  }
  return active;
}

export function messageRowIndex(
  rows: readonly unknown[],
  messageId: number,
): number {
  return rows.findIndex((row) => {
    if (typeof row !== "object" || row === null || !("m" in row)) return false;
    const message = (row as { m?: Pick<Message, "id"> }).m;
    return message?.id === messageId;
  });
}

export function pickActiveMessageId({
  viewableItems,
  atBottom,
  latestId,
}: {
  viewableItems: ReadonlyArray<{ index: number | null; isViewable: boolean; item: unknown }>;
  atBottom: boolean;
  latestId: number;
}): number | null {
  if (atBottom && latestId > 0) return latestId;
  const first = viewableItems
    .filter((token) => token.isViewable)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .find((token) => {
      const item = token.item;
      return typeof item === "object" && item !== null && "m" in item;
    });
  if (!first) return null;
  return ((first.item as { m: Pick<Message, "id"> }).m).id;
}

/* --- Programmatic section jumps -------------------------------------------

   A dot tap can't be a single fire-and-forget scrollToIndex: FlashList v2
   estimates offsets for unmeasured rows (and has no onScrollToIndexFailed),
   so far upward jumps over heterogeneous bubbles land short or on the wrong
   message. On top of that, an in-flight animation can be skewed by an
   older-page prepend shifting indices, and by the bottom-anchoring/viewability
   machinery re-selecting a section under the user's finger.

   The controller below owns one jump at a time: it re-resolves the target
   index *by message id* on every pass (immune to prepends), issues correction
   passes after FlashList's measurement settles (final pass non-animated so it
   pins exactly), and reports "in flight" so callers can pause viewability
   tracking until the jump lands or the user drags. */

export const SECTION_JUMP_PASSES_MS = [350, 700] as const;
export const SECTION_JUMP_SETTLE_MS = 1100;

export interface SectionJumpList {
  scrollToIndex(params: { index: number; animated: boolean; viewPosition: number }): void;
}

export function createSectionJumpController({
  getRows,
  getList,
  onJumpStart,
  settleMs = SECTION_JUMP_SETTLE_MS,
}: {
  getRows: () => readonly unknown[];
  getList: () => SectionJumpList | null;
  /** Fired once per jump with the target mid (optimistic active selection). */
  onJumpStart: (messageId: number) => void;
  settleMs?: number;
}) {
  let timers: ReturnType<typeof setTimeout>[] = [];
  let jumping = false;

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };

  const scrollTo = (messageId: number, animated: boolean) => {
    const index = messageRowIndex(getRows(), messageId);
    if (index >= 0) {
      getList()?.scrollToIndex({ index, animated, viewPosition: 0.08 });
    }
  };

  return {
    isJumping: () => jumping,
    jumpTo(messageId: number) {
      clearTimers();
      jumping = true;
      onJumpStart(messageId);
      scrollTo(messageId, true);
      SECTION_JUMP_PASSES_MS.forEach((delay, i) => {
        const finalPass = i === SECTION_JUMP_PASSES_MS.length - 1;
        timers.push(setTimeout(() => scrollTo(messageId, !finalPass), delay));
      });
      timers.push(setTimeout(() => {
        jumping = false;
      }, settleMs));
    },
    /** A user drag takes over: stop correcting and resume live tracking. */
    cancel() {
      clearTimers();
      jumping = false;
    },
  };
}

/** Everything a screen needs to wire a SectionRail to its FlashList. */
export function useSectionJump({
  listRef,
  rows,
  atBottom,
  latestId,
}: {
  listRef: { current: SectionJumpList | null };
  rows: readonly unknown[];
  atBottom: { current: boolean };
  latestId: number;
}) {
  const [activeMessageId, setActiveMessageId] = useState<number | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const latestIdRef = useRef(latestId);
  latestIdRef.current = latestId;

  const controllerRef = useRef<ReturnType<typeof createSectionJumpController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createSectionJumpController({
      getRows: () => rowsRef.current,
      getList: () => listRef.current,
      onJumpStart: (messageId) => {
        // Stop the bottom-anchoring path (read acking, autoscroll-to-latest)
        // from treating the viewer as "at the bottom" mid-jump.
        atBottom.current = false;
        setActiveMessageId(messageId);
      },
    });
  }
  const controller = controllerRef.current;
  useEffect(() => () => controller.cancel(), [controller]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: {
      viewableItems: ReadonlyArray<{ index: number | null; isViewable: boolean; item: unknown }>;
    }) => {
      // While a jump is in flight the viewport is transient; tracking it would
      // slide the dot window under the user's finger.
      if (controllerRef.current!.isJumping()) return;
      const activeId = pickActiveMessageId({
        viewableItems,
        atBottom: atBottom.current,
        latestId: latestIdRef.current,
      });
      if (activeId != null) setActiveMessageId(activeId);
    },
  ).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 15 }).current;

  const jumpToSection = useCallback((messageId: number) => {
    controller.jumpTo(messageId);
  }, [controller]);
  const cancelSectionJump = useCallback(() => {
    controller.cancel();
  }, [controller]);

  return {
    activeMessageId,
    onViewableItemsChanged,
    viewabilityConfig,
    jumpToSection,
    cancelSectionJump,
  };
}

export function SectionRail({
  messages,
  activeMessageId,
  onJump,
  bottomInset = 12,
}: {
  messages: Message[];
  activeMessageId: number | null;
  onJump: (messageId: number) => void;
  bottomInset?: number;
}) {
  const [maxVisible, setMaxVisible] = useState(MAX_VISIBLE_SECTION_DOTS);
  const agents = useAgents().data;
  const agentColors = useMemo(() => agentRailColors(agents || []), [agents]);
  const sections = useMemo(() => conversationSections(messages, agentColors), [messages, agentColors]);
  const active = activeSectionIndex(sections, activeMessageId);
  const visible = visibleSectionWindow(sections, active, maxVisible);

  if (sections.length < 2) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.rail, { bottom: bottomInset }]}
      onLayout={(event) => setMaxVisible(sectionDotCapacity(event.nativeEvent.layout.height))}
    >
      {visible.map((section) => {
        const selected = section.mid === sections[active]?.mid;
        const agentColor = section.agentId ? agentColors.get(section.agentId) : undefined;
        return (
          <Pressable
            key={section.mid}
            accessibilityRole="button"
            accessibilityLabel={`Jump to: ${section.label}${agentColor ? " (agent)" : ""}`}
            accessibilityState={{ selected }}
            hitSlop={{ top: 3, bottom: 3, left: 6, right: 6 }}
            onPress={() => onJump(section.mid)}
            style={styles.slot}
          >
            <View style={[styles.dot, selected && styles.dotActive, agentDotStyle(agentColor, selected)]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    zIndex: 5,
    right: 2,
    top: "9%",
    width: 20,
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
  },
  slot: {
    width: 20,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.dim,
    opacity: 0.55,
  },
  dotActive: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
    opacity: 1,
  },
});
