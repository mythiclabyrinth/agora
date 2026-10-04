import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AgentsDirectory } from "./AgentsDirectory";
import { useAgentProfile } from "./MessageItem";

const meta = {
  title: "Web/Connected/Agents directory",
  component: AgentsDirectory,
  args: { agents: [{ id: "atlas", name: "Atlas", live: true }, { id: "nova", name: "Nova", live: false }] },
  parameters: { apiRoutes: { "GET /api/agents": { agents: [
    { id: "atlas", name: "Atlas", live: true, requires_mention: true, avatar: null },
    { id: "nova", name: "Nova", live: false, requires_mention: false, avatar: null },
  ] } } },
} satisfies Meta<typeof AgentsDirectory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OpenProfile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Atlas")).resolves.toBeVisible();
    expect(canvas.getByText("Offline")).toBeVisible();
    const card = canvas.getByRole("button", { name: /Atlas.*View profile/ });
    const arrow = card.querySelector(":scope > .ico")!.getBoundingClientRect();
    const label = within(card).getByText("View profile").getBoundingClientRect();
    expect(Math.abs(arrow.right - label.right)).toBeLessThanOrEqual(1);
    expect(arrow.width).toBe(20);
    expect(arrow.height).toBe(20);
    await userEvent.click(card);
    expect(useAgentProfile.getState().openId).toBe("atlas");
  },
};

export const PhoneProfile: Story = {
  ...OpenProfile,
  globals: { viewport: { value: "phone", isRotated: false } },
};

export const EmptyDirectory: Story = {
  args: { agents: [] },
  parameters: { apiRoutes: { "GET /api/agents": { agents: [] } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText(/Ready to connect/)).resolves.toBeVisible();
  },
};
