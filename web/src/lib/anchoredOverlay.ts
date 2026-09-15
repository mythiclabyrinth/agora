export type OverlayAlignment = "start" | "center";

/** Position a fixed overlay beside its anchor and keep it attached through
    viewport resizes and scrolling in any nested pane. */
export function watchAnchoredOverlay(
  anchor: HTMLElement,
  overlay: HTMLElement,
  alignment: OverlayAlignment,
): () => void {
  let frame = 0;
  let releaseResizeGuard = 0;
  let ignoreOverlayResize = false;
  const place = () => {
    frame = 0;
    let wroteSize = false;
    if (overlay.style.maxHeight) {
      ignoreOverlayResize = true;
      overlay.style.maxHeight = "";
      wroteSize = true;
    }
    const rect = anchor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const compact = window.innerWidth <= 820 && viewport && Math.abs(viewport.scale - 1) < .01;
    const viewTop = compact ? viewport.offsetTop : 0;
    const viewLeft = compact ? viewport.offsetLeft : 0;
    const viewHeight = compact ? viewport.height : window.innerHeight;
    const viewWidth = compact ? viewport.width : window.innerWidth;
    const viewBottom = viewTop + viewHeight;
    const offscreen = rect.bottom < viewTop || rect.top > viewBottom;
    overlay.style.visibility = offscreen ? "hidden" : "";
    if (offscreen) {
      if (wroteSize) {
        if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
        releaseResizeGuard = requestAnimationFrame(() => { ignoreOverlayResize = false; });
      }
      return;
    }
    const gutter = 8;
    const gap = 6;
    const naturalHeight = overlay.offsetHeight;
    const aboveSpace = rect.top - viewTop - gap - gutter;
    const belowSpace = viewBottom - rect.bottom - gap - gutter;
    const above = naturalHeight <= aboveSpace || aboveSpace >= belowSpace;
    const available = Math.max(80, above ? aboveSpace : belowSpace);
    const width = overlay.offsetWidth;
    const wantedLeft = alignment === "center"
      ? rect.left + rect.width / 2 - width / 2
      : rect.left;
    const left = Math.max(viewLeft + gutter, Math.min(wantedLeft, viewLeft + viewWidth - width - gutter));
    const height = Math.min(naturalHeight, available, viewHeight - gutter * 2);
    const nextMaxHeight = naturalHeight > height ? `${height}px` : "";
    if (overlay.style.maxHeight !== nextMaxHeight) {
      ignoreOverlayResize = true;
      overlay.style.maxHeight = nextMaxHeight;
      wroteSize = true;
    }
    const wanted = above ? rect.top - height - gap : rect.bottom + gap;
    const top = Math.min(
      Math.max(viewTop + gutter, wanted),
      Math.max(viewTop + gutter, viewBottom - height - gutter),
    );
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.dataset.placement = above ? "above" : "below";
    const arrow = Math.max(12, Math.min(rect.left + rect.width / 2 - left, width - 12));
    overlay.style.setProperty("--ago-anchor-x", `${arrow}px`);
    if (wroteSize) {
      if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
      releaseResizeGuard = requestAnimationFrame(() => { ignoreOverlayResize = false; });
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  const observer = new ResizeObserver((entries) => {
    if (ignoreOverlayResize && entries.every(entry => entry.target === overlay)) return;
    schedule();
  });
  observer.observe(anchor);
  observer.observe(overlay);
  observer.observe(document.documentElement);
  place();
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    document.removeEventListener("scroll", schedule, true);
  };
}
