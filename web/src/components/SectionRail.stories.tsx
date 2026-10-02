import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureAgents,
  fixtureMe,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { SectionRail } from "./SectionRail";
import { MessageItem } from "./MessageItem";
import type { Message } from "@agora/core";

const messages: Message[] = [
  fixtureRootMessage,
  fixtureAgentMessage,
  { ...fixtureRootMessage, id: 46, author_id: "alice", author_name: "Alice", text: "How does the tablet thread overlay behave?" },
  { ...fixtureAgentMessage, id: 47, text: "It now uses an opaque surface, so the channel below never bleeds through." },
  { ...fixtureRootMessage, id: 48, text: "Can we verify keyboard navigation before merging?" },
  { ...fixtureAgentMessage, id: 49, text: "Yes. Click any dot to jump between these three conversational sections." },
];

const agentThread: Message[] = [
  { ...fixtureRootMessage, id: 100, text: "Can we review this thread?" },
  { ...fixtureAgentMessage, id: 101, thread_id: 100, text: "I reviewed the first part." },
  { ...fixtureAgentMessage, id: 102, thread_id: 100, author_id: "claude", author_name: "Claude", text: "I checked the second part." },
  { ...fixtureRootMessage, id: 103, thread_id: 100, text: "Please check the final result." },
  { ...fixtureAgentMessage, id: 104, thread_id: 100, text: "The final result is ready." },
];

function RailSurface({ messages: rows = messages, viewportHeight = 520 }: { messages?: Message[]; viewportHeight?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  return (
    <div
      className="ago-log-wrap"
      style={{
        width: "min(720px, 100%)",
        height: `min(${viewportHeight}px, calc(100vh - 40px))`,
        flex: "0 0 auto",
        overflow: "hidden",
      }}
    >
      <div ref={boxRef} className="ago-log" style={{ height: "100%", minHeight: 0 }}>
        {rows.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            inThread={false}
            isAdmin
            mentions={{}}
            onOpenThread={fn()}
          />
        ))}
      </div>
      <SectionRail boxRef={boxRef} messages={rows} />
    </div>
  );
}

const meta = {
  title: "Web/Navigation/Section rail",
  component: RailSurface,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/agents": { agents: fixtureAgents },
      "GET /api/channels/general/pins": { pins: [] },
      "GET /api/channels/general/stars": { stars: [] },
    },
    docs: {
      description: {
        story: "Three realistic user/agent sections. Hover or focus the right-edge dots, then click one to jump to that topic.",
      },
    },
  },
} satisfies Meta<typeof RailSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleSections: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = await canvas.findByRole("navigation", {
      name: "Jump to a section of the conversation",
    });
    const dots = within(navigation).getAllByRole("button");
    expect(dots).toHaveLength(3);
    const log = canvasElement.querySelector<HTMLElement>(".ago-log");
    if (!log) throw new Error("Missing scrollable message log");
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
    // The dots smooth-scroll; wait for the animation to settle before
    // capturing a reference position, or the second click races it.
    const settled = async () => {
      let last = -1;
      await waitFor(() => {
        const now = log.scrollTop;
        const stable = now === last && now > 0;
        last = now;
        expect(stable).toBe(true);
      }, { interval: 120, timeout: 5000 });
      return log.scrollTop;
    };
    await userEvent.click(dots[2]);
    const lowerPosition = await settled();
    await userEvent.click(dots[0]);
    await waitFor(() => expect(log.scrollTop).toBeLessThan(lowerPosition));
  },
};

export const AgentThread: Story = {
  args: { messages: agentThread, viewportHeight: 360 },
  parameters: {
    apiRoutes: { "GET /api/agents": { agents: fixtureAgents.map(agent => ({ ...agent, rail_marker: true })) } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = await canvas.findByRole("navigation", { name: "Jump to a section of the conversation" });
    await waitFor(() => expect(within(navigation).getAllByRole("button")).toHaveLength(5));
    const dots = within(navigation).getAllByRole("button");
    expect(dots[1].classList.contains("agent")).toBe(true);
    expect(dots[2].getAttribute("aria-label")).toContain("(agent)");
    expect(getComputedStyle(dots[1]).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(dots[1]).borderTopStyle).toBe("solid");
    expect(getComputedStyle(dots[1]).borderTopColor).toBe("rgb(217, 122, 54)");
    await userEvent.click(dots[2]);
    await waitFor(() => expect(dots[2].classList.contains("active")).toBe(true));
    expect(getComputedStyle(dots[2]).backgroundColor).toBe("rgb(210, 85, 133)");
  },
};
