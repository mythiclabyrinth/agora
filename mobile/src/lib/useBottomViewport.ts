import { useCallback, useEffect, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";

/** A taller composer reduces the viewport. Keep the latest message visible
 * only for a reader who was already at the bottom; never move an older view,
 * nor one a landing or section jump is still moving (`isBusy`). */
export function useBottomViewport(
  list: { current: { scrollToEnd: (options: { animated: boolean }) => void } | null },
  atBottom: { current: boolean },
  isBusy: () => boolean = () => false,
) {
  const height = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const busy = useRef(isBusy);
  busy.current = isBusy;
  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
  }, []);
  return useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    const previous = height.current;
    height.current = next;
    if (previous == null || next >= previous || !atBottom.current || busy.current()) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!busy.current()) list.current?.scrollToEnd({ animated: false });
    });
  }, [list, atBottom]);
}
