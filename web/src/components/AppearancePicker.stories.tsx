import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AppearancePicker } from "./AppearancePicker";
import { useAppearance } from "../state/appearance";

const meta = {
  title: "Web/Settings/Appearance",
  component: AppearancePicker,
  decorators: [Story => <div className="conn-panel" style={{ padding: 24 }}><Story />
    <textarea aria-label="Unsent draft" defaultValue="Keep this message while changing appearance" />
  </div>],
} satisfies Meta<typeof AppearancePicker>;
export default meta;
type Story = StoryObj<typeof meta>;

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const rgb = hex.trim().replace("#", "").match(/../g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

export const SwitchWithoutLosingDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const mode of ["Light", "Dark", "System"] as const) {
      await userEvent.click(canvas.getByRole("radio", { name: new RegExp(mode) }));
      await waitFor(() => expect(useAppearance.getState().preference).toBe(mode.toLowerCase()));
      expect(localStorage.getItem("agora_appearance")).toBe(mode.toLowerCase());
      expect(canvas.getByRole("textbox", { name: "Unsent draft" })).toHaveValue("Keep this message while changing appearance");
      expect(document.documentElement.dataset.theme).toBe(mode === "System"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : mode.toLowerCase());
      const css = getComputedStyle(document.documentElement);
      for (const text of ["--text", "--dim", "--faint", "--a1", "--a2", "--green", "--red"])
        for (const surface of ["--bg", "--surface", "--surface-subtle"])
          expect(contrast(css.getPropertyValue(text), css.getPropertyValue(surface)), `${mode} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  },
};
export const Light: Story = { parameters: { appearance: "light" } };
export const Dark: Story = { parameters: { appearance: "dark" } };
export const Phone: Story = { globals: { viewport: { value: "smallPhone", isRotated: false } } };
