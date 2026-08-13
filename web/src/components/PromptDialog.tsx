import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PromptDialogProps {
  title: string;
  description: string;
  label: string;
  value: string;
  pending?: boolean;
  onClose: () => void;
  onSave: (value: string) => void;
}

export function PromptDialog({ title, description, label, value: initialValue, pending, onClose, onSave }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(pending);
  const id = useId();
  const titleId = `${id}-title`;
  const inputId = `${id}-input`;
  closeRef.current = onClose;
  pendingRef.current = pending;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    inputRef.current?.select();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) closeRef.current();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => previous?.isConnected && previous.focus());
    };
  }, []);

  const submit = () => {
    if (!pending) onSave(value.trim());
  };

  return createPortal(
    <div className="conn-overlay" onClick={event => event.stopPropagation()}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}>
      <div className="conn-panel ago-thread-rename-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        <form onSubmit={event => { event.preventDefault(); submit(); }}>
          <label htmlFor={inputId}>{label}</label>
          <input ref={inputRef} id={inputId} value={value}
            onChange={event => setValue(event.target.value)} disabled={pending} />
          <div className="ago-thread-rename-actions">
            <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
