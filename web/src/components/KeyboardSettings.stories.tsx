import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, within } from "storybook/test";
import { useShortcutState } from "../state/shortcuts";
import { currentPlatform } from "@agora/core";
import { KeyboardSettings } from "./KeyboardSettings";

const meta = {
  title: "Web/Connected/Keyboard settings",
  component: KeyboardSettings,
  parameters: { setup: () => useShortcutState.setState({ bindings: {} }) },
} satisfies Meta<typeof KeyboardSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("button", { name: "Reset all shortcuts" })).resolves.toBeVisible();
  },
};

export const RecordingAndConflict: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const change = await canvas.findByRole("button", { name: "Change Search conversations shortcut" });
    fireEvent.click(change);
    await expect(canvas.findByText("Press keys…")).resolves.toBeVisible();
    fireEvent.keyDown(change, { key: "u", code: "KeyU", [currentPlatform() === "mac" ? "metaKey" : "ctrlKey"]: true, shiftKey: true });
    await expect(canvas.findByRole("alertdialog", { name: "Shortcut conflict" })).resolves.toBeVisible();
  },
};

export const ReservedKey: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const change = await canvas.findByRole("button", { name: "Change Search conversations shortcut" });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "w", code: "KeyW", [currentPlatform() === "mac" ? "metaKey" : "ctrlKey"]: true });
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent("Reserved");
  },
};

export const ResetConflict: Story = {
  parameters: { setup: () => useShortcutState.setState({ bindings: { search: "Mod+Shift+KeyU", "nav.unreads": null } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    fireEvent.click(await canvas.findByRole("button", { name: "Reset Go to Unreads shortcut" }));
    await expect(canvas.findByRole("alertdialog", { name: "Shortcut conflict" })).resolves.toHaveTextContent("Search conversations");
    fireEvent.click(canvas.getByRole("button", { name: "Replace" }));
    await expect(canvas.queryByRole("alertdialog", { name: "Shortcut conflict" })).toBeNull();
    expect(useShortcutState.getState().bindings.search).toBeNull();
    expect(useShortcutState.getState().bindings["nav.unreads"]).toBeUndefined();
  },
};
