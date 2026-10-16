import { useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { fixtureMarkdown } from "@agora/core/testing/fixtures";
import { MdText } from "./MdText";
import { resetRichCopyFallback } from "../lib/copyMdBlock";

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
    await userEvent.click(page.getByRole("button", { name: "Close chart" }));
    expect(canvas.getByRole("button", { name: "Expand chart: Revenue" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Expand chart: Revenue" }));
  },
};

// Swap navigator.clipboard for the duration of a play function.
async function withClipboard(value: object, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
  try { await run(); } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
}

const slackQuote = [
  "Here's a tightened version you can paste into Slack:",
  "",
  "> Skyler's coding agent can now run on our ChatGPT (Codex) subscription. Just tell Skyler to **\"use codex\"** and it'll run the task on GPT-6 Sol.",
  ">",
  "> It's **not the default**. DeepSeek still is. Next week I'll look at a dedicated subscription for the coding agent.",
  ">",
  "> If you notice anything new or odd with Opus or DeepSeek, ask @tom & <check> here.",
  "",
  "What changed and why:",
  "- **\"use codex\" instead of \"provider Codex … model Sol\".** \"Use codex\" is the exact phrase Skyler maps to `--model codex`, so people are more likely to trigger it correctly.",
  "- **Added the OpenCode upgrade.** It's the real reason DeepSeek and Opus users might see differences.",
  "  - Nested detail one",
  "  - Nested detail two",
  "1. Ordered steps stay numbered",
  "2. Even right after a bullet list",
].join("\n");

export const QuoteAndLists: Story = {
  args: { text: slackQuote, mentions: { tom: "Tom" } },
  parameters: { docs: { description: { story: "A Slack-ready blockquote (one box, one copy button) followed by bullet, nested, and numbered lists." } } },
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelectorAll("blockquote.md-quote")).toHaveLength(1);
    expect(canvasElement.querySelector(".md-quote")!.textContent).not.toMatch(/^>|\n>/);
    expect(canvasElement.querySelectorAll("ul.md-list > li")).toHaveLength(4);
    expect(canvasElement.querySelectorAll("ol.md-list > li")).toHaveLength(2);
    expect(canvasElement.querySelector(".md-quote .ago-mention")).toHaveTextContent("Tom");
    resetRichCopyFallback();
    const write = fn().mockResolvedValue(undefined);
    await withClipboard({ write, writeText: fn() }, async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: "Copy quote" }));
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const item = write.mock.calls[0][0][0] as ClipboardItem;
      const plain = await (await item.getType("text/plain")).text();
      const html = await (await item.getType("text/html")).text();
      expect(plain).toBe([
        "Skyler's coding agent can now run on our ChatGPT (Codex) subscription. Just tell Skyler to **\"use codex\"** and it'll run the task on GPT-6 Sol.",
        "",
        "It's **not the default**. DeepSeek still is. Next week I'll look at a dedicated subscription for the coding agent.",
        "",
        "If you notice anything new or odd with Opus or DeepSeek, ask @tom & <check> here.",
      ].join("\n"));
      expect(html).toContain("<b>not the default</b>");
      expect(html).toContain("&lt;check&gt;");
      expect(html).toContain("GPT-6 Sol.<br><br>It&#39;s");
      expect(html).not.toContain("md-copy");
      await waitFor(() => expect(within(canvasElement).getByRole("button", { name: "Copied" })).toBeVisible());
    });
    // A webview that has ClipboardItem but rejects rich writes still copies plain text.
    const rejecting = fn().mockRejectedValue(new Error("NotAllowedError"));
    const plain = fn().mockResolvedValue(undefined);
    await withClipboard({ write: rejecting, writeText: plain }, async () => {
      await userEvent.click(within(canvasElement).getByRole("button", { name: /Copy quote|Copied/ }));
      await waitFor(() => expect(plain).toHaveBeenCalledWith(expect.stringContaining("**not the default**")));
    });
  },
};

const longLine = "curl -sS -X POST https://agora.example.test/api/messages -H 'Authorization: Bearer $AGORA_TOKEN' "
  + "-d '{\"channel\":\"kite\",\"text\":\"a deliberately long single line that has to scroll sideways to reach its end\"}' # END";

export const CodeBlockCopy: Story = {
  args: {
    text: ["Run this to post a message:", "", "```bash", longLine, "echo done", "```", "", "- In a list:", "  ```json", "  {", "    \"ok\": true", "  }", "  ```"].join("\n"),
  },
  parameters: { docs: { description: { story: "A horizontally scrolling code block keeps its copy button fixed in the corner, with end padding so the last characters clear it." } } },
  play: async ({ canvasElement }) => {
    const pre = canvasElement.querySelector<HTMLElement>(".md-code > .md-pre")!;
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    pre.scrollLeft = pre.scrollWidth;
    // The end of the longest line sits left of the button once fully scrolled.
    const button = canvasElement.querySelector<HTMLElement>(".md-code > .md-copy")!;
    const range = document.createRange();
    const textNode = pre.querySelector(".md-code-text")!.firstChild!;
    const end = textNode.textContent!.indexOf("# END") + 5;
    range.setStart(textNode, end - 1);
    range.setEnd(textNode, end);
    await waitFor(() => expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(button.getBoundingClientRect().left));
    // Indented fence under a list item loses its indentation.
    expect(canvasElement.querySelectorAll(".md-pre")[1].textContent).toBe("{\n  \"ok\": true\n}");
    const writeText = fn().mockResolvedValue(undefined);
    await withClipboard({ writeText }, async () => {
      await userEvent.click(within(canvasElement).getAllByRole("button", { name: "Copy code" })[0]);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${longLine}\necho done`));
    });
    // A rejected write warns and never shows the copied check.
    const failing = fn().mockRejectedValue(new Error("denied"));
    await withClipboard({ writeText: failing }, async () => {
      const button = within(canvasElement).getAllByRole("button", { name: /Copy code|Copied/ })[1];
      await userEvent.click(button);
      await waitFor(() => expect(failing).toHaveBeenCalled());
      await expect(within(canvasElement.ownerDocument.body).findByText(/Couldn't copy/)).resolves.toBeVisible();
      expect(button).not.toHaveClass("copied");
    });
  },
};

export const QuotedChartFence: Story = {
  args: {
    text: ["> The chart source, quoted:", "> ```echarts", "> {\"series\":[{\"type\":\"bar\",\"data\":[1,2]}]}", "> ```", "> End of quote."].join("\n"),
  },
  parameters: { docs: { description: { story: "A chart fenced inside a quote stays inside the one quote box as its source." } } },
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelectorAll("blockquote.md-quote")).toHaveLength(1);
    expect(canvasElement.querySelector(".md-quote")).toHaveTextContent("End of quote.");
    expect(canvasElement.querySelector(".md-quote .md-echarts .md-pre")).toBeInTheDocument();
    expect(canvasElement.querySelector(".ago-chart-block")).not.toBeInTheDocument();
  },
};

export const ChartInListItem: Story = {
  args: {
    text: ["- Revenue:", "  ```echarts", "  " + JSON.stringify({ title: { text: "Listed" }, xAxis: { type: "category", data: ["A"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1] }] }), "  ```", "  Note: Q3 only", "- Next"].join("\n"),
  },
  parameters: { docs: { description: { story: "A chart fenced under a list item renders inside that item, and the list stays one list." } } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector("ul.md-list > li .ago-chart-block canvas")).toBeInTheDocument());
    expect(canvasElement.querySelectorAll("ul.md-list")).toHaveLength(1);
    expect(canvasElement.querySelectorAll("ul.md-list > li")).toHaveLength(2);
    expect(canvasElement.querySelector("ul.md-list > li")).toHaveTextContent("Note: Q3 only");
  },
};

export const ArrowBeforeChartFence: Story = {
  args: {
    text: ["Revenue -> ```echarts", JSON.stringify({ title: { text: "Arrow" }, xAxis: { type: "category", data: ["A"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1] }] }), "```"].join("\n"),
  },
  parameters: { docs: { description: { story: "A `>` that isn't a quote marker (an arrow) still lets the chart fence draw." } } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".ago-chart-block canvas")).toBeInTheDocument());
  },
};

function MentionsArriveLater({ text }: { text: string }) {
  const [mentions, setMentions] = useState<Record<string, string>>({});
  return <>
    <MdText text={text} mentions={mentions} />
    <button type="button" onClick={() => setMentions({ tom: "Tom" })}>Load mentions</button>
  </>;
}

export const ChartSurvivesMentionsLoading: Story = {
  args: {
    text: ["Ask @tom about this:", "```echarts", JSON.stringify({ title: { text: "Stable" }, xAxis: { type: "category", data: ["A"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1] }] }), "```"].join("\n"),
  },
  render: (args) => <MentionsArriveLater text={args.text} />,
  parameters: { docs: { description: { story: "When the mentions map arrives after first paint, the prose re-decorates but the chart keeps its canvas." } } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector(".ago-chart-block canvas")).toBeInTheDocument());
    const before = canvasElement.querySelector(".ago-chart-block canvas");
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Load mentions" }));
    await waitFor(() => expect(canvasElement.querySelector(".ago-mention")).toHaveTextContent("Tom"));
    expect(canvasElement.querySelector(".ago-chart-block canvas")).toBe(before);
  },
};

function EditRemovesFirstChart({ first, second }: { first: string; second: string }) {
  const [text, setText] = useState(`${first}\n\n${second}`);
  return <>
    <MdText text={text} mentions={{}} />
    <button type="button" onClick={() => setText(second)}>Remove first chart</button>
  </>;
}

const titledChart = (title: string) => ["```echarts", JSON.stringify({ title: { text: title }, xAxis: { type: "category", data: ["A"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1] }] }), "```"].join("\n");

export const EditRemovesAChart: Story = {
  args: { text: "" },
  render: () => <EditRemovesFirstChart first={titledChart("First")} second={titledChart("Second")} />,
  parameters: { docs: { description: { story: "An edit that drops the first of two charts leaves exactly the remaining chart, in its slot." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll(".md-echarts-slot .ago-chart-block canvas")).toHaveLength(2));
    await userEvent.click(canvas.getByRole("button", { name: "Remove first chart" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Expand chart: Second" })).toBeInTheDocument());
    expect(canvas.queryByRole("button", { name: "Expand chart: First" })).not.toBeInTheDocument();
    expect(canvasElement.querySelectorAll(".md-echarts-slot")).toHaveLength(1);
    expect(canvasElement.querySelectorAll(".ago-chart-block")).toHaveLength(1);
  },
};

// Records the height a parent's layout effect sees, as MessageLog's scroll
// anchoring does, on the first commit.
function MeasuredOnFirstCommit({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => { setMeasured(ref.current?.offsetHeight ?? 0); }, []);
  return <div ref={ref} data-measured={measured ?? ""}><MdText text={text} mentions={{}} /></div>;
}

export const ChartHeightOnFirstCommit: Story = {
  args: { text: "" },
  render: () => <MeasuredOnFirstCommit text={["Weekly:", titledChart("Measured")].join("\n")} />,
  parameters: { docs: { description: { story: "A parent's layout effect already sees the chart's full height on the first commit, so scroll anchoring above a chart doesn't jump." } } },
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>("[data-measured]")!;
    await waitFor(() => expect(box.dataset.measured).not.toBe(""));
    // The default chart is 360px tall; prose alone is a line or two.
    expect(Number(box.dataset.measured)).toBeGreaterThan(300);
  },
};

export const RichCopyFailsOnce: Story = {
  args: { text: "> Quote one\n\nBetween\n\n> Quote two" },
  parameters: { docs: { description: { story: "A webview that refuses rich copy and then the late plain fallback (WebKit) fails once; later quote copies go straight to plain text inside the click. A refusal whose fallback works leaves rich copy on." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Transient refusal, fallback works: rich copy stays enabled.
    resetRichCopyFallback();
    const transient = fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
    const okText = fn().mockResolvedValue(undefined);
    await withClipboard({ write: transient, writeText: okText }, async () => {
      const [first, second] = canvas.getAllByRole("button", { name: /Copy quote|Copied/ });
      await userEvent.click(first);
      await waitFor(() => expect(okText).toHaveBeenCalledWith("Quote one"));
      await userEvent.click(second);
      await waitFor(() => expect(transient).toHaveBeenCalledTimes(2));
    });
    // WebKit: rich refused and the late fallback refused too, then plain in-gesture.
    resetRichCopyFallback();
    const refuse = fn().mockRejectedValue(new Error("text/html refused"));
    const lateText = fn().mockRejectedValueOnce(new Error("gesture expired")).mockResolvedValue(undefined);
    await withClipboard({ write: refuse, writeText: lateText }, async () => {
      const [first, second] = canvas.getAllByRole("button", { name: /Copy quote|Copied/ });
      await userEvent.click(first);
      await expect(within(canvasElement.ownerDocument.body).findAllByText(/Couldn't copy/)).resolves.not.toHaveLength(0);
      await userEvent.click(second);
      await waitFor(() => expect(lateText).toHaveBeenLastCalledWith("Quote two"));
      expect(refuse).toHaveBeenCalledTimes(1);
    });
    resetRichCopyFallback();
  },
};
