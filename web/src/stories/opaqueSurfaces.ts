import { expect } from "storybook/test";
import { colorAlpha } from "./colorAlpha.mjs";

// Check the painted surface, not deliberately transparent scrims or positioning
// wrappers (e.g. .jv-dock and .ago-react-pop have opaque children).
export const overlaySurfaces = [
  ".ago-thread-view-sheet", ".ago-message-secondary:popover-open", ".ago-inbox-menu:popover-open",
  ".ago-template-pop", ".ago-access-popover", ".conn-panel", ".ago-search-panel", ".ago-dm-popover",
  ".ago-emoji-pop", ".ago-react-pop-body", ".ago-pin-pop", ".ago-mention-pop", ".ago-addr-pop",
  ".ago-composer-extra-options", ".ago-topbar-tools.open", ".ago-draft-menu", ".jv-panel",
  ".agora-side", ".agora-thread", ".agora-members-pane", ".agora-files-pane",
].join(", ");

// Entrance animations start at opacity 0; still check their background alpha.
function checkSurface(surface: HTMLElement) {
  const color = getComputedStyle(surface).backgroundColor;
  expect(colorAlpha(color), `${surface.className || surface.tagName} must paint an opaque surface (${color})`).toBe(1);
}

export function expectOpaqueSurface(selector: string) {
  const visible = [...document.querySelectorAll<HTMLElement>(selector)].filter(el => el.checkVisibility({ visibilityProperty: true }));
  expect(visible.length, `Expected a visible surface matching ${selector}`).toBeGreaterThan(0);
  visible.forEach(checkSurface);
}

// These role=dialog nodes are scrims, not the painted panel. Require their
// opaque child instead. The media lightbox intentionally darkens the page
// around the image and has no solid panel.
const dialogWrappers = [
  { selector: ".ago-chart-overlay", child: ".ago-chart-modal" },
  { selector: ".ago-map-overlay", child: ".ago-map-panel" },
  { selector: ".ago-image-lightbox", child: null },
];

export function expectOpaqueSurfaces() {
  const selectors = `${overlaySurfaces}, dialog[open], :popover-open, [role="dialog"]`;
  for (const surface of document.querySelectorAll<HTMLElement>(selectors)) {
    if (!surface.checkVisibility({ visibilityProperty: true })) continue;
    const wrapper = dialogWrappers.find(item => surface.matches(item.selector));
    if (wrapper) {
      if (wrapper.child) {
        const child = surface.querySelector<HTMLElement>(wrapper.child);
        expect(child?.checkVisibility({ visibilityProperty: true }), `Expected visible ${wrapper.child}`).toBe(true);
        checkSurface(child!);
      }
      continue;
    }
    checkSurface(surface);
  }
}
