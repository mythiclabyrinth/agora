import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { expectOpaqueSurface, expectOpaqueSurfaces } from "./opaqueSurfaces";

const meta = {
  title: "Regression/Overlay opacity guard",
  render: () => <p>Guard checks require visible surfaces and cover new overlay classes.</p>,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MissingAndHidden: Story = {
  play: () => {
    expect(() => expectOpaqueSurface(".missing-test-surface")).toThrow(/Expected a visible surface/);
    const hidden = document.createElement("div");
    hidden.className = "hidden-test-surface";
    hidden.style.display = "none";
    document.body.append(hidden);
    try {
      expect(() => expectOpaqueSurface(".hidden-test-surface")).toThrow(/Expected a visible surface/);
      hidden.style.display = "block";
      hidden.style.visibility = "hidden";
      expect(() => expectOpaqueSurface(".hidden-test-surface")).toThrow(/Expected a visible surface/);
    } finally { hidden.remove(); }
  },
};

export const NewOverlayClasses: Story = {
  play: () => {
    for (const kind of ["native-dialog", "popover", "aria-dialog"]) {
      const surface = document.createElement(kind === "native-dialog" ? "dialog" : "div");
      surface.textContent = "A newly introduced overlay";
      if (kind === "popover") surface.setAttribute("popover", "auto");
      if (kind === "aria-dialog") surface.setAttribute("role", "dialog");
      document.body.append(surface);
      try {
        if (surface instanceof HTMLDialogElement) surface.showModal();
        if (kind === "popover") surface.showPopover();
        for (const background of ["transparent", "rgba(255,255,255,.028)", "oklch(50% .1 30 / 50%)"]) {
          surface.style.background = background;
          expect(() => expectOpaqueSurfaces()).toThrow(/must paint an opaque surface/);
        }
        for (const background of ["rgb(20 30 40)", "oklch(50% .1 30)", "color-mix(in srgb, white, black)"]) {
          surface.style.background = background;
          expectOpaqueSurfaces();
        }
      } finally { surface.remove(); }
    }
  },
};

export const EntranceAnimation: Story = {
  play: () => {
    const surface = document.createElement("div");
    surface.className = "entrance-test-surface";
    surface.setAttribute("role", "dialog");
    surface.textContent = "First frame of an entrance animation";
    surface.style.opacity = "0";
    document.body.append(surface);
    try {
      surface.style.background = "rgba(255,255,255,.028)";
      expect(() => expectOpaqueSurface(".entrance-test-surface")).toThrow(/must paint an opaque surface/);
      expect(() => expectOpaqueSurfaces()).toThrow(/must paint an opaque surface/);
      surface.style.background = "rgb(20 30 40)";
      expectOpaqueSurface(".entrance-test-surface");
      expectOpaqueSurfaces();
    } finally { surface.remove(); }
  },
};
