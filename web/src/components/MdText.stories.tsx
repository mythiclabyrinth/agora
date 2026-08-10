import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { fixtureMarkdown } from "@agora/core/testing/fixtures";
import { MdText } from "./MdText";

const meta = {
  title: "Web/Atoms/Markdown",
  component: MdText,
  args: { mentions: {} },
  // MdText always renders inside a .bubble in production — the bubble carries
  // the word-break/max-width rules long content depends on.
  decorators: [(Story) => (
    <div className="ago-log" style={{ width: "min(760px, 100%)" }}>
      <div className="bubble assistant ago-bubble"><Story /></div>
    </div>
  )],
} satisfies Meta<typeof MdText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: { text: fixtureMarkdown },
  parameters: {
    docs: { description: { story: "A realistic release note exercising headings, emphasis, inline code, a link, a checklist, a table, and a quote." } },
  },
};

export const LongUnbrokenContent: Story = {
  args: {
    text: [
      "A copied build-artifact URL must wrap without widening the message pane:",
      "",
      "https://downloads.example.test/agora/builds/2026-07-30/desktop/apple-silicon/agora-component-catalog-release-candidate-with-a-deliberately-long-unbroken-checksum-7f94c38be229b91f61755ba4c7e92626d5f0d9a8b671c95d4f79a34c2e8a1d60.zip",
    ].join("\n"),
  },
  parameters: {
    docs: { description: { story: "A realistic long, unbroken artifact URL proving links wrap instead of forcing horizontal scrolling." } },
  },
};

export const EChartsMessage: Story = {
  args: {
    text: [
      "Here is the activity trend:",
      "",
      "```echarts",
      JSON.stringify({
        title: { text: "Weekly activity" }, tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
        yAxis: { type: "value" },
        series: [{ type: "line", smooth: true, data: [12, 19, 15, 28, 24, 32, 30] }],
      }),
      "```",
      "",
      "The weekend remained strong.",
    ].join("\n"),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".ago-chart-block canvas")).toBeInTheDocument());
    await expect(canvasElement.querySelector(".md-echarts")).not.toBeInTheDocument();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Expand chart: Weekly activity" }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Weekly activity" });
    expect(within(dialog).queryByRole("button", { name: "Next chart" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close chart" }));
  },
  parameters: {
    docs: { description: { story: "Exercises an ECharts fence through the real markdown message renderer." } },
  },
};

const chartFence = (title: string, data: number[]) => [
  "```echarts",
  JSON.stringify({ title: { text: title }, xAxis: { type: "category", data: ["A", "B", "C"] }, yAxis: { type: "value" }, series: [{ type: "bar", data }] }),
  "```",
].join("\n");

export const MultiChartMessageNavigation: Story = {
  args: {
    text: [
      "Three chart fences in one message; the invalid middle fence is not part of navigation.",
      chartFence("Revenue", [12, 18, 24]),
      "```echarts\n{ invalid json\n```",
      chartFence("Retention", [72, 78, 81]),
      chartFence("Activation", [44, 51, 63]),
    ].join("\n\n"),
  },
  parameters: { docs: { description: { story: "Message-level chart gallery navigation with an invalid fence excluded from the valid chart count." } } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll(".ago-chart-block canvas")).toHaveLength(3));
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Expand chart: Revenue" }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("dialog", { name: "Revenue" })).resolves.toBeVisible();
    expect(page.getByText("Chart 1 of 3")).toBeVisible();
    expect(page.getByRole("button", { name: "Previous chart" })).toBeDisabled();
    await userEvent.keyboard("{ArrowRight}");
    await expect(page.findByRole("dialog", { name: "Retention" })).resolves.toBeVisible();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await expect(page.findByRole("dialog", { name: "Retention" })).resolves.toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Next chart" }));
    expect(page.getByText("Chart 3 of 3")).toBeVisible();
    expect(page.getByRole("button", { name: "Next chart" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Previous chart" }));
    expect(page.getByText("Chart 2 of 3")).toBeVisible();
  },
};
