import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useShortcutState } from "../state/shortcuts";
import { ShortcutsDialog } from "./ShortcutsDialog";

const meta = {
  title: "Web/Connected/Keyboard shortcuts",
  component: ShortcutsDialog,
  parameters: {
    apiRoutes: { "GET /api/me": { ...fixtureMe, voice_stt: true } },
    setup: () => useShortcutState.setState({ sheetOpen: true, bindings: {} }),
  },
} satisfies Meta<typeof ShortcutsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mac: Story = {
  args: { platformOverride: "mac" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("dialog", { name: "Keyboard shortcuts" })).resolves.toBeVisible();
    await expect(canvas.findByText("Talk to agents")).resolves.toBeVisible();
    await expect(canvas.findByText("⌘⇧2")).resolves.toBeVisible();
    await expect(canvas.findByText("⌘⇧Y")).resolves.toBeVisible();
  },
};

export const Windows: Story = {
  args: { platformOverride: "other" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Ctrl+Shift+2")).resolves.toBeVisible();
    await expect(canvas.findByText("Ctrl+Shift+Y")).resolves.toBeVisible();
  },
};

export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("textbox", { name: "Filter keyboard shortcuts" }), "voice");
    await expect(canvas.findByText("Stop and send recording")).resolves.toBeVisible();
    expect(canvas.queryByText("Talk to agents")).toBeNull();
  },
};
