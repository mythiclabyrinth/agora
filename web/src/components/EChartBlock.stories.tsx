import type { Meta, StoryObj } from "@storybook/react-vite";
import { normalizeEChart } from "@agora/core";
import { EChartBlock } from "./EChartBlock";

const line = JSON.stringify({
  title: { text: "Weekly activity" }, tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
  yAxis: { type: "value" }, series: [{ type: "line", smooth: true, data: [12, 19, 15, 28, 24, 32, 30] }],
});

const meta = {
  title: "Web/Atoms/ECharts",
  component: EChartBlock,
  args: { source: line, chart: normalizeEChart(line) },
  decorators: [(Story) => <div style={{ width: "min(720px, 100%)" }}><Story /></div>],
} satisfies Meta<typeof EChartBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResponsiveLine: Story = {};
export const WideScrollable: Story = {
  args: (() => { const source = JSON.stringify({
    agora: { width: 1400, height: 360 }, option: {
      title: { text: "Long timeline" }, tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: Array.from({ length: 30 }, (_, i) => `Day ${i + 1}`) },
      yAxis: { type: "value" }, series: [{ type: "bar", data: Array.from({ length: 30 }, (_, i) => (i * 13) % 47) }],
    },
  }); return { source, chart: normalizeEChart(source) }; })(),
};
export const InvalidJson: Story = { args: { source: "{ definitely not json", chart: null, error: "Invalid JSON" } };
