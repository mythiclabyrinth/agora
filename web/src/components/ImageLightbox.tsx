import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";

type Zoom = { scale: number; x: number; y: number };
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

function clampAxis(size: number, viewport: number, stageCenter: number, value: number) {
  if (size <= viewport) {
    return Math.max(size / 2, Math.min(viewport - size / 2, stageCenter)) - stageCenter;
  }
  return Math.max(viewport - size / 2, Math.min(size / 2, stageCenter + value)) - stageCenter;
}

function clampPan(scale: number, x: number, y: number, image: HTMLImageElement, stage: HTMLElement, overlay: HTMLElement) {
  const iw = image.clientWidth * scale;
  const ih = image.clientHeight * scale;
  const rect = stage.getBoundingClientRect();
  return {
    x: clampAxis(iw, overlay.clientWidth, rect.left + rect.width / 2, x),
    y: clampAxis(ih, overlay.clientHeight, rect.top + rect.height / 2, y),
  };
}

export function ImageLightbox({
  url,
  filename,
  onClose,
  index,
  total,
  onPrevious,
  onNext,
}: {
  url: string;
  filename: string;
  onClose: () => void;
  index?: number;
  total?: number;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  const zoomRef = useRef<Zoom>({ scale: 1, x: 0, y: 0 });
  const imageKey = `${index ?? ""}:${url}`;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ mode: "pan" | "pinch"; x: number; y: number; pointerStartX: number; pointerStartY: number; distance: number; scale: number; focalX: number; focalY: number; originX: number; originY: number; captured: boolean } | null>(null);
  const moved = useRef(false);
  const lastMoveAt = useRef(0);
  const [zoom, setZoom] = useState<Zoom>(zoomRef.current);
  onCloseRef.current = onClose;
  const gallery = index !== undefined && total !== undefined && total > 1;
  onPreviousRef.current = gallery && index > 0 ? onPrevious : undefined;
  onNextRef.current = gallery && index < total - 1 ? onNext : undefined;

  const commit = useCallback((next: Zoom) => {
    const value = imageRef.current && stageRef.current && lightboxRef.current
      ? { ...next, ...clampPan(next.scale, next.x, next.y, imageRef.current, stageRef.current, lightboxRef.current) }
      : next;
    zoomRef.current = value;
    setZoom(value);
  }, []);
  const setAt = useCallback((scale: number, clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return;
    const rect = stage.getBoundingClientRect();
    const focalX = clientX - (rect.left + rect.width / 2);
    const focalY = clientY - (rect.top + rect.height / 2);
    const previous = zoomRef.current;
    const nextScale = scale < 1.01 && scale < previous.scale ? 1 : scale;
    const ratio = nextScale / previous.scale;
    commit({ scale: nextScale, x: focalX - (focalX - previous.x) * ratio, y: focalY - (focalY - previous.y) * ratio });
  }, [commit]);
  const reset = useCallback(() => commit({ scale: 1, x: 0, y: 0 }), [commit]);
  const nudgeZoom = useCallback((factor: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setAt(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current.scale * factor)), rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [setAt]);

  useLayoutEffect(() => {
    reset();
    pointers.current.clear();
    gesture.current = null;
    moved.current = false;
    lastMoveAt.current = 0;
  }, [imageKey, reset]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      const plainShortcut = !event.altKey && !event.ctrlKey && !event.metaKey;
      if (plainShortcut && (event.key === "+" || event.key === "=")) { event.preventDefault(); nudgeZoom(1.25); }
      if (plainShortcut && event.key === "-") { event.preventDefault(); nudgeZoom(0.8); }
      if (plainShortcut && event.key === "0") { event.preventDefault(); reset(); }
      const current = zoomRef.current;
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const step = 48;
        if (current.scale > 1 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          const next = { ...current,
            x: current.x + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0),
            y: current.y + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
          };
          const stage = stageRef.current;
          const image = imageRef.current;
          const overlay = lightboxRef.current;
          const bounded = stage && image && overlay ? clampPan(next.scale, next.x, next.y, image, stage, overlay) : next;
          const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
          const axisOverflows = image && overlay && (horizontal
            ? image.clientWidth * current.scale > overlay.clientWidth
            : image.clientHeight * current.scale > overlay.clientHeight);
          const canPan = axisOverflows && (horizontal ? bounded.x !== current.x : bounded.y !== current.y);
          if (canPan) {
            event.preventDefault();
            commit({ ...next, ...bounded });
          } else if (!horizontal) {
            event.preventDefault();
          } else if (event.repeat) {
            event.preventDefault();
          } else if (event.key === "ArrowLeft" && onPreviousRef.current) { event.preventDefault(); onPreviousRef.current(); }
          else if (event.key === "ArrowRight" && onNextRef.current) { event.preventDefault(); onNextRef.current(); }
        } else if (event.key === "ArrowLeft" && onPreviousRef.current) { event.preventDefault(); onPreviousRef.current(); }
        else if (event.key === "ArrowRight" && onNextRef.current) { event.preventDefault(); onNextRef.current(); }
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!controls.length) return;
        const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1) : (currentIndex === controls.length - 1 ? 0 : currentIndex + 1);
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commit, nudgeZoom, reset]);

  useEffect(() => {
    const lightbox = lightboxRef.current;
    if (!lightbox) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (lightbox.clientHeight || window.innerHeight) : 1;
      const exponent = Math.max(-0.5, Math.min(0.5, -event.deltaY * unit * 0.006));
      setAt(Math.max(1, Math.min(MAX_ZOOM, zoomRef.current.scale * Math.exp(exponent))), event.clientX, event.clientY);
    };
    lightbox.addEventListener("wheel", onWheel, { passive: false });
    return () => lightbox.removeEventListener("wheel", onWheel);
  }, [setAt]);

  useEffect(() => {
    const lightbox = lightboxRef.current;
    const stage = stageRef.current;
    if (!lightbox || !stage) return;
    let start: Zoom = { scale: 1, x: 0, y: 0 };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      if (pointers.current.size) return;
      start = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (pointers.current.size) return;
      const gestureEvent = event as Event & { scale: number; clientX?: number; clientY?: number };
      const rect = stage.getBoundingClientRect();
      const cx = gestureEvent.clientX ?? rect.left + rect.width / 2;
      const cy = gestureEvent.clientY ?? rect.top + rect.height / 2;
      const nextScale = Math.max(1, Math.min(MAX_ZOOM, start.scale * gestureEvent.scale));
      const focalX = cx - (rect.left + rect.width / 2);
      const focalY = cy - (rect.top + rect.height / 2);
      const ratio = nextScale / start.scale;
      commit({ scale: nextScale, x: focalX - (focalX - start.x) * ratio, y: focalY - (focalY - start.y) * ratio });
    };
    lightbox.addEventListener("gesturestart", onGestureStart, { passive: false });
    lightbox.addEventListener("gesturechange", onGestureChange, { passive: false });
    lightbox.addEventListener("gestureend", onGestureChange, { passive: false });
    return () => {
      lightbox.removeEventListener("gesturestart", onGestureStart);
      lightbox.removeEventListener("gesturechange", onGestureChange);
      lightbox.removeEventListener("gestureend", onGestureChange);
    };
  }, [commit]);

  const imageDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - lastMoveAt.current < 300) return;
    setAt(zoomRef.current.scale > 1 ? 1 : 2, event.clientX, event.clientY);
  };

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1 && zoomRef.current.scale > 1) {
      gesture.current = { mode: "pan", x: event.clientX, y: event.clientY, pointerStartX: event.clientX, pointerStartY: event.clientY, distance: 0, scale: zoomRef.current.scale, focalX: 0, focalY: 0, originX: zoomRef.current.x, originY: zoomRef.current.y, captured: false };
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      try {
        for (const pointerId of pointers.current.keys()) event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // Synthetic pointer events in browser tests do not have active pointers to capture.
      }
      gesture.current = { mode: "pinch", x: 0, y: 0, pointerStartX: 0, pointerStartY: 0, distance: Math.hypot(a.x - b.x, a.y - b.y), scale: zoomRef.current.scale,
        focalX: (a.x + b.x) / 2, focalY: (a.y + b.y) / 2, originX: zoomRef.current.x, originY: zoomRef.current.y, captured: true };
    }
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.buttons === 0 && pointers.current.has(event.pointerId)) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
      pointerUp(event);
      return;
    }
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    if (!active) return;
    if (active.mode === "pan" && pointers.current.size === 1) {
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      if (Math.hypot(event.clientX - active.pointerStartX, event.clientY - active.pointerStartY) > 3) {
        moved.current = true;
        lastMoveAt.current = Date.now();
        if (!active.captured) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
            active.captured = true;
          } catch {
            // Synthetic pointer events in browser tests do not have an active pointer to capture.
          }
        }
      }
      active.x = event.clientX; active.y = event.clientY;
      commit({ ...zoomRef.current, x: zoomRef.current.x + dx, y: zoomRef.current.y + dy });
    } else if (active.mode === "pinch" && pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = Math.max(1, Math.min(MAX_ZOOM, active.scale * distance / Math.max(active.distance, 1)));
      const focalX = (a.x + b.x) / 2;
      const focalY = (a.y + b.y) / 2;
      if (Math.abs(scale - active.scale) > 0.02 || Math.abs(focalX - active.focalX) + Math.abs(focalY - active.focalY) > 3) {
        moved.current = true;
        lastMoveAt.current = Date.now();
      }
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const relativeX = focalX - (rect.left + rect.width / 2);
      const relativeY = focalY - (rect.top + rect.height / 2);
      const startX = active.focalX - (rect.left + rect.width / 2);
      const startY = active.focalY - (rect.top + rect.height / 2);
      const ratio = scale / active.scale;
      commit({ scale, x: relativeX - (startX - active.originX) * ratio, y: relativeY - (startY - active.originY) * ratio });
    }
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 1 && gesture.current?.mode === "pinch" && zoomRef.current.scale > 1) {
      const [remaining] = Array.from(pointers.current.values());
      gesture.current = { mode: "pan", x: remaining.x, y: remaining.y, pointerStartX: remaining.x, pointerStartY: remaining.y, distance: 0, scale: zoomRef.current.scale, focalX: 0, focalY: 0, originX: zoomRef.current.x, originY: zoomRef.current.y, captured: true };
    } else if (!pointers.current.size) {
      gesture.current = null;
    }
  };
  const zoomPercent = `${Math.round(zoom.scale * 100)}%`;
  const canZoomOut = zoom.scale > MIN_ZOOM;
  const canZoomIn = zoom.scale < MAX_ZOOM;

  return createPortal((
    <div ref={lightboxRef} className="ago-image-lightbox" role="dialog" aria-modal="true" aria-label={`Image preview: ${filename}`}
      onPointerDownCapture={() => { if (pointers.current.size === 0) moved.current = false; }}
      onClick={(event) => { if (event.target === event.currentTarget && !moved.current) onClose(); }}>
      <div ref={dialogRef} className="ago-image-lightbox-inner">
        <div className="ago-image-stage-wrap">
          <button ref={closeRef} type="button" className="ago-image-lightbox-close" aria-label="Close image preview" onClick={onClose}><Icon name="x" /></button>
          <div ref={stageRef} className={`ago-media-frame ago-image-stage${zoom.scale > 1 ? " is-zoomed" : ""}`} onPointerDown={pointerDown} onPointerMove={pointerMove}
            onPointerUp={pointerUp} onPointerCancel={pointerUp} onDoubleClick={imageDoubleClick}>
            <img ref={imageRef} key={imageKey} src={url} alt={filename} draggable={zoom.scale > 1 ? false : undefined}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }} />
          </div>
        </div>
        <div className="ago-image-zoom-toolbar" role="group" aria-label="Image zoom controls">
          <button type="button" aria-label="Zoom out" aria-disabled={!canZoomOut} onClick={() => { if (canZoomOut) nudgeZoom(0.8); }}>−</button>
          <button type="button" aria-label={`Zoom level ${zoomPercent}; reset zoom`} onClick={reset}>{zoomPercent}</button>
          <button type="button" aria-label="Zoom in" aria-disabled={!canZoomIn} onClick={() => { if (canZoomIn) nudgeZoom(1.25); }}>+</button>
        </div>
        {gallery ? <>
          <button type="button" className="ago-media-arrow prev" disabled={index === 0} aria-label="Previous image" onClick={onPrevious}><Icon name="chevron-left" /></button>
          <button type="button" className="ago-media-arrow next" disabled={index === total - 1} aria-label="Next image" onClick={onNext}><Icon name="chevron-right" /></button>
          <span className="ago-media-counter" aria-live="polite" aria-atomic="true">Image {index + 1} of {total}</span>
        </> : null}
      </div>
    </div>
  ), document.body);
}
