import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

/* Room the title keeps before the header's tools collapse behind ⋯. */
const MIN_TITLE_PX = 160;

/** Whether a pane header's inline tools still fit next to its title.

    Measured with a ResizeObserver rather than a CSS container query: the pane
    can be narrow inside a wide window (a docked thread plus the Files or
    Schedules pane), and containment would re-anchor its fixed popovers. The
    width the inline tools need is remembered while they show, so the header
    only expands again once that much room is back. */
export function useHeaderOverflow(remeasureKey: string) {
  const [narrow, setNarrow] = useState(false);
  const needed = useRef(0);
  const head = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(() => {
    const el = head.current;
    if (!el) return;
    setNarrow(wasNarrow => {
      if (!wasNarrow) {
        const title = el.querySelector<HTMLElement>(":scope > .ago-head-text");
        needed.current = el.scrollWidth - (title?.offsetWidth ?? 0) + MIN_TITLE_PX;
      }
      return el.clientWidth < needed.current - (wasNarrow ? 0 : 1);
    });
  }, []);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    head.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    observer.current = ro;
  }, [measure]);
  // Header content (labels, admin-only buttons) can change without a resize.
  useLayoutEffect(() => { if (!narrow) measure(); }, [remeasureKey, narrow, measure]);
  return { ref, narrow };
}

/** A pane header's tools behind a ⋯ button: an anchored popover on a pointer
    screen, an opaque bottom sheet on a phone. `enabled` false keeps the
    tools inline (no popover attribute at all). */
export function useHeaderMenu(enabled: boolean) {
  const phone = useMediaQuery("(max-width: 640px)");
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!open || !enabled || phone || !menu || !trigger) return;
    const stop = watchAnchoredOverlay(trigger, menu, "end");
    return () => {
      stop();
      // A phone lays the sheet out in CSS; drop the anchored geometry.
      menu.style.left = menu.style.top = menu.style.maxHeight = menu.style.visibility = "";
      menu.style.removeProperty("--ago-anchor-x");
      delete menu.dataset.placement;
    };
  }, [open, enabled, phone]);
  const close = useCallback(() => {
    const menu = menuRef.current;
    try {
      if (menu?.matches(":popover-open")) menu.hidePopover();
    } catch { /* no popover support: nothing is open */ }
  }, []);
  /** Close after picking an item, unless it asks to stay (a confirm step). */
  const onMenuClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    const button = (event.target as HTMLElement).closest("button");
    if (button && !button.hasAttribute("data-keep-open")) close();
  }, [enabled, close]);
  const triggerProps = enabled
    ? { ref: triggerRef, popoverTarget: menuId, "aria-expanded": open, "aria-controls": menuId }
    : { ref: triggerRef, "aria-expanded": false };
  const menuProps = enabled
    ? {
        id: menuId, ref: menuRef, popover: "auto" as const,
        onToggle: (e: { newState: string }) => setOpen(e.newState === "open"),
        onClick: onMenuClick,
        // Handled here too (not only by the UA) so focus returns to ⋯.
        onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          close();
          triggerRef.current?.focus();
        },
      }
    : { ref: menuRef };
  return { open, phone, close, triggerProps, menuProps };
}
