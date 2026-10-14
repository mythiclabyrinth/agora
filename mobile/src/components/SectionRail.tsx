/* Native conversation section navigation. The narrow, intentionally
   touch-capturing strip overlays a message list without reducing bubble
   width; long timelines use a fixed window instead of a nested scroller. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import {
  conversationSections,
  agentRailColors,
  useAgents,
  type ConversationSection,
  type Message,
} from "@agora/core";

import { createThemedStyles } from "../lib/useTheme";

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
/** A safety net only: how long one pass waits for its scroll to report
    settled. A scroll that takes longer means the list is broken, so the jump
    finishes there (settled once) rather than holding everything paused
    behind it through more passes. Generous on purpose: a healthy far landing
    still rendering on a slow device must not be cut off. */
export const SECTION_JUMP_PASS_TIMEOUT_MS = 8000;

export interface SectionJumpList {
  /** FlashList resolves once the scroll (and its offset re-enable) settles. */
  scrollToIndex(params: {
    index: number;
    animated: boolean;
    viewPosition: number;
  }): void | Promise<void>;
}

/** Dots land a section's first message near the top; a message landing
    (deep link, search hit, divider) picks its own position and skips the
    animation, since it can travel hundreds of rows. */
export interface SectionJumpOptions {
  viewPosition?: number;
  animated?: boolean;
  /** The jump landed and settled (not called when cancelled). */
  onSettled?: () => void;
}

export function createSectionJumpController({
  getRows,
  getList,
  onJumpStart,
  settleMs = SECTION_JUMP_SETTLE_MS,
  passTimeoutMs = SECTION_JUMP_PASS_TIMEOUT_MS,
}: {
  getRows: () => readonly unknown[];
  getList: () => SectionJumpList | null;
  /** Fired once per jump with the target mid (optimistic active selection). */
  onJumpStart: (messageId: number) => void;
  settleMs?: number;
  passTimeoutMs?: number;
}) {
  let timers: ReturnType<typeof setTimeout>[] = [];
  // The pass awaiting its scroll's promise, if any (one at a time).
  let passTimeout: ReturnType<typeof setTimeout> | null = null;
  let jumping = false;
  let generation = 0;

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    if (passTimeout) clearTimeout(passTimeout);
    passTimeout = null;
  };

  /** Continue right away when there's nothing to wait for (no list mounted,
      the row isn't loaded, or a fire-and-forget list); for a list that
      reports completion, once its promise settles, or `stuck` if the safety
      timeout fires first. Whichever comes second is ignored. */
  const afterScroll = (
    result: void | Promise<void> | undefined,
    next: () => void,
    stuck: () => void,
  ) => {
    if (!result || typeof result.then !== "function") {
      next();
      return;
    }
    let done = false;
    let timeout: ReturnType<typeof setTimeout>;
    const once = (then: () => void) => () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      // A later jump may own the slot by now.
      if (passTimeout === timeout) passTimeout = null;
      then();
    };
    // In the background nothing renders, so a scroll can't settle there:
    // that's not a broken list, and the pass waits another period.
    const arm = () => {
      timeout = setTimeout(() => {
        // A backgrounded or inactive app (switcher, Control Center, a call)
        // defers it; an unknown state (null early in startup) doesn't.
        const state = AppState.currentState;
        if (state === "background" || state === "inactive") arm();
        else once(stuck)();
      }, passTimeoutMs);
      passTimeout = timeout;
    };
    arm();
    void result.then(once(next), once(next));
  };

  const scrollTo = (messageId: number, animated: boolean, viewPosition: number) => {
    const list = getList();
    // Unmounted: nothing will ever settle, so there's nothing to wait for.
    if (!list) return undefined;
    const index = messageRowIndex(getRows(), messageId);
    if (index < 0) return undefined;
    try {
      return list.scrollToIndex({ index, animated, viewPosition });
    } catch (e) {
      // FlashList throws before its layout manager exists; a landing calls
      // this from an effect, where a throw would take the screen down.
      console.warn("section jump: scrollToIndex failed", e);
      return undefined;
    }
  };

  return {
    isJumping: () => jumping,
    jumpTo(
      messageId: number,
      { viewPosition = 0.08, animated = true, onSettled }: SectionJumpOptions = {},
    ) {
      clearTimers();
      const jump = ++generation;
      jumping = true;
      onJumpStart(messageId);
      const finish = () => {
        if (jump !== generation) return;
        jumping = false;
        onSettled?.();
      };
      // Each pass waits for the previous scroll to settle: when the JS thread
      // is busy rendering a far target, timer-driven passes would otherwise
      // pile up and overlap, and FlashList's interleaved offset pauses leave
      // the native position and the rendered window out of sync (a blank
      // viewport).
      const pass = (i: number, previousAt: number) => {
        if (jump !== generation) return;
        if (i === SECTION_JUMP_PASSES_MS.length) {
          timers.push(setTimeout(finish, settleMs - previousAt));
          return;
        }
        const at = SECTION_JUMP_PASSES_MS[i];
        timers.push(setTimeout(() => {
          if (jump !== generation) return;
          const finalPass = i === SECTION_JUMP_PASSES_MS.length - 1;
          afterScroll(scrollTo(messageId, animated && !finalPass, viewPosition), () => pass(i + 1, at), finish);
        }, at - previousAt));
      };
      afterScroll(scrollTo(messageId, animated, viewPosition), () => pass(0, 0), finish);
    },
    /** A user drag takes over: stop correcting and resume live tracking. */
    cancel() {
      clearTimers();
      generation += 1;
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
        // Stop the bottom-anchoring path (read acking, follow-latest pinning)
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

  const jumpToSection = useCallback((messageId: number, options?: SectionJumpOptions) => {
    controller.jumpTo(messageId, options);
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
    isSectionJumping: controller.isJumping,
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
  const styles = useStyles();
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

const useStyles = createThemedStyles(({ colors }) => ({
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
}));
