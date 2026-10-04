import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { WorkspaceSettings } from "./WorkspaceSettings";

const rename = fn(() => ({ ok: true }));
const meta = {
  title: "Web/Settings/Workspace",
  component: WorkspaceSettings,
  parameters: { apiRoutes: {
    "GET /api/connections": { instance: { id: "workspace-id", name: "Northwind Labs" }, connections: [] },
    "PUT /api/instance": rename,
  } },
} satisfies Meta<typeof WorkspaceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RenameWorkspace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Workspace name");
    expect(canvas.getByRole("button", { name: "Save name" })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "New workspace");
    await userEvent.click(canvas.getByRole("button", { name: "Save name" }));
    expect(rename).toHaveBeenCalledWith({ name: "New workspace" });
  },
};
