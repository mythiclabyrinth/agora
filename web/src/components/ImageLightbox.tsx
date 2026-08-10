import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";

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
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const onPreviousRef = useRef(onPrevious);
  const onNextRef = useRef(onNext);
  onCloseRef.current = onClose;
  onPreviousRef.current = onPrevious;
  onNextRef.current = onNext;
  const gallery = index !== undefined && total !== undefined && total > 1;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft") onPreviousRef.current?.();
        if (event.key === "ArrowRight") onNextRef.current?.();
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!controls.length) return;
        const current = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current === controls.length - 1 ? 0 : current + 1);
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal((
    <div
      className="ago-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${filename}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="ago-image-lightbox-inner">
        <button
          ref={closeRef}
          type="button"
          className="ago-image-lightbox-close"
          aria-label="Close image preview"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
        <div className="ago-media-frame">
          <img key={url} src={url} alt={filename} />
        </div>
        {gallery ? (
          <div className="ago-media-navigation">
            <button type="button" disabled={index === 0} aria-label="Previous image" onClick={onPrevious}>
              <Icon name="chevron-left" /> Previous
            </button>
            <span aria-live="polite" aria-atomic="true">Image {index + 1} of {total}</span>
            <button type="button" disabled={index === total - 1} aria-label="Next image" onClick={onNext}>
              Next <Icon name="chevron-right" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  ), document.body);
}
