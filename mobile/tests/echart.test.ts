import { echartHtml } from "../src/lib/echarts";
import { normalizeEChart } from "@agora/core";
import { themes } from "../src/lib/theme";

test.each(["light", "dark"] as const)("embedded charts follow %s appearance", mode => {
  const html = echartHtml(normalizeEChart(JSON.stringify({ series: [{ type: "bar", data: [1] }] })), themes[mode]);
  expect(html).toContain(`background:${themes[mode].colors.bg}`);
  expect(html).toContain(`color:${themes[mode].colors.text}`);
  expect(html).toContain(`echarts.init(stage,${mode === "dark" ? '"dark"' : "null"},`);
});

test("chart WebView pins ECharts and keeps option markup out of HTML", () => {
  const chart = normalizeEChart(JSON.stringify({
    tooltip: { formatter: "<img src=x onerror=alert(1)>" },
    series: [{ type: "bar", data: [1, 2] }],
  }));
  const html = echartHtml(chart);
  expect(html).toContain("echarts@6.1.0/dist/echarts.min.js");
  expect(html).toContain("\\u003cimg src=x onerror=alert(1)>");
  expect(html).not.toContain('formatter":"<img');
  expect(html).toContain('renderMode":"richText"');
  expect(html).toContain('confine":true');
});

test("chart stage fills its native box instead of the option's pixel height", () => {
  const chart = normalizeEChart(JSON.stringify({
    agora: { height: 300 },
    option: { series: [{ type: "line", data: [1, 2] }] },
  }));
  const html = echartHtml(chart);
  // The native side sizes the WebView (bounded inline, measured when expanded),
  // so a fixed px stage would leave dead space in a taller box.
  expect(html).toContain("height:100vh");
  expect(html).not.toContain("height:300px");
  expect(html).toContain("ResizeObserver");
});
