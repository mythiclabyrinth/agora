import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../hooks/useDialogFocus";

export function ThreadViewDialog({ children, onClose, triggerRef }: {
  children: ReactNode; onClose: () => void; triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const backdropPress = useRef(false);
  useEffect(() => {
    const trigger = triggerRef.current;
    const dialog = ref.current!;
    // Keep the sheet in the top layer with an inert background.
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [triggerRef]);
  // Register after showModal so the hook captures a control inside this dialog;
  // its deferred cleanup cannot override the explicit Safari trigger restoration.
  const panelRef = useDialogFocus(true, onClose);
  return createPortal(
    <dialog ref={ref} className="ago-thread-view-sheet" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onPointerDown={event => { backdropPress.current = event.target === event.currentTarget; }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={event => {
        if (backdropPress.current && event.target === event.currentTarget) onClose();
        backdropPress.current = false;
      }}>
      <div ref={panelRef} tabIndex={-1} className="ago-thread-view-body"
        onKeyDown={event => event.stopPropagation()}>
        <h2 id={titleId}>Thread view</h2>
        <p>Changes apply immediately.</p>
        <div className="ago-thread-view-controls">{children}</div>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </dialog>, document.body,
  );
}
