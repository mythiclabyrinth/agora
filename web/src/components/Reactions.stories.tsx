import { expectOpaqueSurface } from "../stories/opaqueSurfaces";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within, expect } from "storybook/test";
import { Reactions } from "./Reactions";
import { me, message } from "../stories/fixtures/data";
import { fixtureAgents, fixtureUsers } from "@agora/core/testing/fixtures";

const removeReaction = fn(() => message);

async function expectInViewport(tooltip: HTMLElement) {
  const rect = tooltip.getBoundingClientRect();
  await expect(rect.left).toBeGreaterThanOrEqual(8);
  await expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 8);
  await expect(rect.top).toBeGreaterThanOrEqual(8);
  await expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
}

async function openAndCheckViewport(canvasElement: HTMLElement) {
  const chip = await within(canvasElement).findByRole("button", { name: /reacted with 👍/ });
  await userEvent.hover(chip);
  const tooltip = await within(document.body).findByRole("tooltip");
  await expectInViewport(tooltip);
  expectOpaqueSurface(".ago-react-pop-body");
  return { chip, tooltip };
}

const meta = {
  title: "Web/Messages/Reactions",
  component: Reactions,
  args: { message, onPick: fn() },
  parameters: {
    apiRoutes: {
      "GET /api/me": me,
      "GET /api/users": { users: fixtureUsers },
      "GET /api/agents": { agents: fixtureAgents },
      "DELETE /api/channels/general/messages/42/reactions/%F0%9F%91%8D": removeReaction,
      "PUT /api/channels/general/messages/42/reactions/%F0%9F%8E%89": message,
    },
  },
} satisfies Meta<typeof Reactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mine = await canvas.findByRole("button", { name: /Tom, Alice, Codex reacted with 👍/ });
    await expect(mine).toHaveClass("mine");
    const { tooltip } = await openAndCheckViewport(canvasElement);
    await expect(tooltip).toHaveTextContent("Codex");
    await userEvent.unhover(mine);
    await userEvent.click(mine);
    await expect(removeReaction).toHaveBeenCalled();
  },
};

export const LeftViewportEdge: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", left: 0, top: 180 }}><Story /></div>],
  play: async ({ canvasElement }) => { await openAndCheckViewport(canvasElement); },
};

export const RightViewportEdge: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", right: 0, top: 180 }}><Story /></div>],
  play: async ({ canvasElement }) => { await openAndCheckViewport(canvasElement); },
};

export const FlipsBelowNearTop: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", left: 180, top: 0 }}><Story /></div>],
  play: async ({ canvasElement }) => {
    const { tooltip } = await openAndCheckViewport(canvasElement);
    await expect(tooltip).toHaveAttribute("data-placement", "below");
  },
};

export const StaysAboveNearBottom: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", left: 180, bottom: 0 }}><Story /></div>],
  play: async ({ canvasElement }) => {
    const { tooltip } = await openAndCheckViewport(canvasElement);
    await expect(tooltip).toHaveAttribute("data-placement", "above");
  },
};

export const InsideOverflowContainer: Story = {
  decorators: [(Story) => (
    <div data-testid="scroll-box" style={{ width: 360, height: 100, overflow: "auto", margin: 120 }}>
      <div style={{ height: 35 }} />
      <Story />
      <div style={{ height: 120 }} />
    </div>
  )],
  play: async ({ canvasElement }) => {
    const { tooltip } = await openAndCheckViewport(canvasElement);
    const before = tooltip.getBoundingClientRect().top;
    const scroller = within(canvasElement).getByTestId("scroll-box");
    scroller.scrollTop = 24;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await expectInViewport(tooltip);
    await expect(tooltip.getBoundingClientRect().top).not.toBe(before);
  },
};

export const LongReactorList: Story = {
  args: {
    message: {
      ...message,
      reactions: [{
        emoji: "👍",
        users: Array.from({ length: 18 }, (_, i) => `person-${i + 1}`),
        reactors: Array.from({ length: 18 }, (_, i) => ({
          type: "user" as const,
          id: `person-${i + 1}`,
          name: `Person ${i + 1}`,
        })),
      }],
    },
  },
  play: async ({ canvasElement }) => {
    const { tooltip } = await openAndCheckViewport(canvasElement);
    const body = tooltip.querySelector<HTMLElement>(".ago-react-pop-body");
    await expect(body).not.toBeNull();
    await expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
  },
};

export const LegacyServerPayload: Story = {
  args: {
    message: {
      ...message,
      reactions: [{ emoji: "👍", users: ["tom", "alice"] }],
    },
  },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", {
      name: /tom, alice reacted with 👍/,
    });
    await expect(chip).toHaveClass("mine");
  },
};
