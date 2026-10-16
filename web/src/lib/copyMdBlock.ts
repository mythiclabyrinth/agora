/* Copy buttons on rendered markdown quotes and code blocks (see MdText). */

import { mdliteClipboardHtml } from "@agora/core";
import { toast } from "./toast";

const copiedTimers = new WeakMap<HTMLButtonElement, number>();

/** Copy a quote as rich text with its markdown as the plain-text fallback,
    or a code block as plain text. */
export async function copyMdBlock(button: HTMLButtonElement, text: string) {
  // Each clipboard call starts synchronously inside the click (no await
  // before it): WebKit — the macOS and Linux desktop webviews — only allows
  // clipboard writes during the user gesture.
  const plain = () => {
    if (!navigator.clipboard?.writeText) return Promise.reject(new Error("Clipboard unavailable"));
    return navigator.clipboard.writeText(text);
  };
  const supports = typeof ClipboardItem === "undefined" ? undefined
    : (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  const rich = button.dataset.copyKind === "quote" && typeof ClipboardItem !== "undefined"
    && !!navigator.clipboard?.write && !(supports && !supports("text/html"));
  try {
    if (rich) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([mdliteClipboardHtml(text)], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
      } catch {
        // Some webviews expose ClipboardItem but refuse text/html; plain text
        // still beats failing outright (where the gesture still allows it).
        await plain();
      }
    } else {
      await plain();
    }
  } catch {
    toast("Couldn't copy — select the text and copy it manually", { variant: "warn" });
    return;
  }
  button.classList.add("copied");
  button.setAttribute("aria-label", "Copied");
  window.clearTimeout(copiedTimers.get(button));
  copiedTimers.set(button, window.setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", button.title);
  }, 1500));
}
