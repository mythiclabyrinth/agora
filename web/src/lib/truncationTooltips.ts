/** Full-text native tooltips for labels that CSS already clips. No new
 * truncation, observers, layout changes, or overrides of authored tooltips.
 * Measure on interaction so resized panes and newly mounted rows work too. */
export function installTruncationTooltips(root: Document = document): () => void {
  const owned = new Map<HTMLElement, string>();
  const clear = (related: EventTarget | null = null) => {
    for (const [node, title] of owned) {
      if (related instanceof Node && node.contains(related)) continue;
      if (node.getAttribute("title") === title) node.removeAttribute("title");
      owned.delete(node);
    }
  };
  const show = (event: Event) => {
    clear(event.target);
    let node = event.target instanceof Element ? event.target : null;
    while (node && node !== root.documentElement) {
      if (node instanceof HTMLElement && !node.matches("input, textarea, select, [contenteditable=true]")) {
        const own = owned.get(node);
        if (!node.hasAttribute("title") || own !== undefined) {
          const css = getComputedStyle(node);
          const ellipsis = css.textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth + 1;
          const clamped = Number(css.webkitLineClamp) > 0 && node.scrollHeight > node.clientHeight + 1;
          const text = node.textContent?.replace(/\s+/g, " ").trim();
          if ((ellipsis || clamped) && text) {
            node.title = text;
            owned.set(node, text);
          } else if (own !== undefined) {
            node.removeAttribute("title");
            owned.delete(node);
          }
        }
      }
      node = node.parentElement;
    }
  };
  const hide = (event: Event) => clear((event as MouseEvent | FocusEvent).relatedTarget);
  root.addEventListener("pointerover", show);
  root.addEventListener("focusin", show);
  root.addEventListener("pointerout", hide);
  root.addEventListener("focusout", hide);
  return () => {
    clear();
    root.removeEventListener("pointerover", show);
    root.removeEventListener("focusin", show);
    root.removeEventListener("pointerout", hide);
    root.removeEventListener("focusout", hide);
  };
}
