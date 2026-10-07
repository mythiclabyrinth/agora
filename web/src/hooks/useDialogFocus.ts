import { useEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];
export const hasOpenDialog = (): boolean => dialogs.length > 0;
export const isTopDialog = (element: HTMLElement | null): boolean => !!element && dialogs.at(-1) === element;
const controls = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Focus and Escape belong to the topmost dialog; restore the initiating control on close. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const panel = ref.current;
    if (!open || !panel) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogs.push(panel);
    panel.focus();
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== panel || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest?.("[data-capturing-shortcut]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key !== "Tab") return;
      const items = [...panel.querySelectorAll<HTMLElement>(controls)]
        .filter(item => item.getClientRects().length && !item.closest('[hidden], [inert]'));
      const first = items[0], last = items.at(-1);
      if (!first || !panel.contains(document.activeElement) || document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      const index = dialogs.indexOf(panel);
      if (index !== -1) dialogs.splice(index, 1);
      document.removeEventListener("keydown", keydown, true);
      requestAnimationFrame(() => {
        const top = dialogs.at(-1);
        if (previous?.isConnected && (!top || top.contains(previous))) previous.focus();
      });
    };
  }, [open]);
  return ref;
}
