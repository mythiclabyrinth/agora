import { useLayoutEffect, useRef } from "react";

const KEY = "agora_thread_width";
const MIN = 320;
const MAX = 720;

/** Resize through CSS once per frame; never rerender the message tree during
 * a drag. Only the finished width is persisted, and touch layouts opt out. */
export function ThreadResizeHandle() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const handle = ref.current, pane = handle?.parentElement, layout = pane?.parentElement;
    if (!handle || !pane || !layout) return;
    const desktop = matchMedia("(min-width: 1101px) and (hover: hover) and (pointer: fine)");
    let max = MAX, frame = 0, startX = 0, startWidth = 0, pending = 0;
    let pointer: number | null = null, preferred: number | null = null;
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (Number.isFinite(saved) && saved >= MIN && saved <= MAX) preferred = saved;
    } catch { /* Storage can be unavailable in managed browsers. */ }
    const enabled = () => desktop.matches && !layout.classList.contains("thread-expanded");
    const clamp = (width: number) => Math.round(Math.min(max, Math.max(MIN, width)));
    const apply = (width: number) => {
      const next = clamp(width);
      pane.style.setProperty("--thread-width", `${next}px`);
      handle.setAttribute("aria-valuenow", String(next));
      handle.setAttribute("aria-valuetext", `${next} pixels`);
      return next;
    };
    const persist = () => {
      try {
        if (preferred === null) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, String(preferred));
      } catch { /* The current layout still works without persistence. */ }
    };
    const measure = () => {
      if (!enabled()) return;
      const occupied = [...layout.children].filter(node => node !== pane && !node.classList.contains("agora-main"))
        .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
      max = Math.max(MIN, Math.min(MAX, layout.clientWidth - occupied - 320));
      pane.style.setProperty("--thread-max-width", `${max}px`);
      handle.setAttribute("aria-valuemax", String(Math.round(max)));
      if (preferred !== null) apply(preferred);
      else handle.setAttribute("aria-valuenow", String(Math.round(pane.getBoundingClientRect().width)));
    };
    const flush = () => { frame = 0; apply(pending); };
    const finish = () => {
      if (pointer === null) return;
      if (frame) { cancelAnimationFrame(frame); flush(); }
      preferred = clamp(pending); persist();
      const id = pointer; pointer = null;
      layout.classList.remove("thread-resizing");
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    };
    const down = (event: PointerEvent) => {
      if (!enabled() || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); measure();
      pointer = event.pointerId; startX = event.clientX;
      startWidth = pane.getBoundingClientRect().width; pending = startWidth;
      handle.setPointerCapture(pointer); handle.focus();
      layout.classList.add("thread-resizing");
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pending = startWidth + startX - event.clientX;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const reset = () => {
      if (!enabled()) return;
      preferred = null; pane.style.removeProperty("--thread-width"); persist(); measure();
    };
    const key = (event: KeyboardEvent) => {
      if (!enabled()) return;
      if (event.key === "Escape" && pointer !== null) { event.preventDefault(); pending = startWidth; apply(startWidth); finish(); return; }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); measure();
      const step = event.shiftKey ? 64 : 24, current = pane.getBoundingClientRect().width;
      preferred = apply(event.key === "Home" ? MIN : event.key === "End" ? max : current + (event.key === "ArrowLeft" ? step : -step));
      persist();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    for (const sibling of layout.children) if (sibling !== pane && !sibling.classList.contains("agora-main")) observer.observe(sibling);
    desktop.addEventListener("change", measure);
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("keydown", key);
    window.addEventListener("blur", finish);
    measure();
    return () => {
      finish(); if (frame) cancelAnimationFrame(frame);
      observer.disconnect(); desktop.removeEventListener("change", measure);
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      handle.removeEventListener("dblclick", reset);
      handle.removeEventListener("keydown", key);
      window.removeEventListener("blur", finish);
    };
  }, []);
  return <div ref={ref} className="ago-thread-resizer" role="separator" aria-orientation="vertical"
    aria-label="Resize thread panel" aria-controls="agora-thread" aria-valuemin={MIN} aria-valuemax={MAX}
    tabIndex={0} title="Drag to resize thread · double-click to reset · arrow keys to adjust" />;
}
