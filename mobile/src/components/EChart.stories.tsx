import type { Meta, StoryObj } from "@storybook/react-native";
import { normalizeEChart } from "@agora/core";
import { fixtureDenseTrendCharts } from "@agora/core/testing/fixtures";
import { EChartBlock } from "./EChart";

const line = JSON.stringify({
  title: { text: "Weekly activity" },
  tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
  yAxis: { type: "value" },
  series: [{ type: "line", smooth: true, data: [12, 19, 15, 28, 24, 32, 30] }],
});

const meta = {
  title: "Native/Messages/ECharts",
  component: EChartBlock,
  args: { code: line, chart: normalizeEChart(line), maxWidth: 340 },
} satisfies Meta<typeof EChartBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResponsiveLine: Story = {};
export const WideScrollable: Story = {
  args: (() => { const code = JSON.stringify({
    agora: { width: 1200, height: 300 },
    option: {
      title: { text: "Long timeline" }, tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `${i}:00`) },
      yAxis: { type: "value" }, series: [{ type: "bar", data: Array.from({ length: 24 }, (_, i) => (i * 7) % 31) }],
    },
  }); return { code, chart: normalizeEChart(code) }; })(),
};
/* A dense agent payload: ~165 daily points whose values move fractions of a
   percent, which is the case that reads as a flat line without an axis that
   scales to the data. */
export const DenseTrendLine: Story = { args: { code: fixtureDenseTrendCharts[3], chart: normalizeEChart(fixtureDenseTrendCharts[3]) } };
export const InvalidJson: Story = { args: { code: "{ definitely not json", chart: null, error: "Invalid JSON" } };
