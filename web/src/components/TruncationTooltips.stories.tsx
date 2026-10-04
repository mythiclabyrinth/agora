import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { installTruncationTooltips } from "../lib/truncationTooltips";

const long = "A longer channel and thread title that should remain fully readable on hover";
function Labels() {
  useEffect(installTruncationTooltips, []);
  return <div style={{ padding: 24 }}>
    <div className="ago-chan" style={{ width: 180 }}><span className="nm" tabIndex={0}>{long}</span></div>
    <div className="ago-chan" style={{ width: 180 }}><span className="nm">Short label</span></div>
    <div className="ago-chan" style={{ width: 180 }}><span className="nm" title="Existing helpful tooltip">An existing tooltip should never be replaced</span></div>
    <div className="ago-search-snippet" style={{ width: 140 }}>A multiline preview with enough content to exceed two lines should also expose its complete text without changing the row height.</div>
  </div>;
}
const meta = { title: "Web/Accessibility/Truncated labels", component: Labels } satisfies Meta<typeof Labels>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OnlyWhenClipped: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText(long);
    const before = label.getBoundingClientRect();
    await userEvent.hover(label);
    expect(label).toHaveAttribute("title", long);
    expect(label.getBoundingClientRect().height).toBe(before.height);
    const short = canvas.getByText("Short label");
    await userEvent.hover(short);
    expect(short).not.toHaveAttribute("title");
    expect(label).not.toHaveAttribute("title");
    const authored = canvas.getByText("An existing tooltip should never be replaced");
    await userEvent.hover(authored);
    expect(authored).toHaveAttribute("title", "Existing helpful tooltip");
    const multiline = canvas.getByText(/A multiline preview/);
    await userEvent.hover(multiline);
    expect(multiline).toHaveAttribute("title", multiline.textContent);
    // Re-measure after a resize: a now-unclipped label gets no extra tooltip.
    label.parentElement!.style.width = "1000px";
    await userEvent.hover(label);
    expect(label).not.toHaveAttribute("title");
  },
};
