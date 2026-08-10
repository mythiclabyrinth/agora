/* MdText table/code rendering. The regression these guard: a horizontal
   ScrollView only scrolls natively when its frame has a *definite* width, so
   MdText must feed the measured onLayout width into the table (and code) wrap
   as a numeric maxWidth. Without it the ScrollView grows to content width and
   the bubble just clips it — no horizontal scroll. */

/* Same stub as messageitem.test.ts: lucide ships untransformed ESM (MdText
   pulls it in via the mermaid block card). */
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ScrollView, StyleSheet } from "react-native";
import { columnWidths, MdText } from "../src/components/MdText";
import { parseInline, type Span } from "@agora/core";

const TABLE = "| Category | Transactions | USD |\n|---|---|---|\n| PAI ATM | 3 | $159.00 |";

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

function fireLayout(node: TestRenderer.ReactTestInstance, width: number) {
  act(() => {
    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
  });
}

function maxWidthOf(style: unknown): number | undefined {
  return (StyleSheet.flatten(style) as { maxWidth?: number }).maxWidth;
}

test("table ScrollView has no definite width before layout, and the measured width after", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(MdText, { text: TABLE }));
  });
  const scroll = () => tree.root.findAllByType(ScrollView)[0];

  // Before measurement the frame is unconstrained (would grow to content).
  expect(maxWidthOf(scroll().props.style)).toBeUndefined();

  // The root View carries the onLayout; feeding it the bubble's inner width…
  const layoutHost = tree.root.findAll(
    (n: TestRenderer.ReactTestInstance) => typeof n.props.onLayout === "function",
  )[0];
  fireLayout(layoutHost, 260);

  // …caps the table's ScrollView to that definite pixel width, so a wider
  // table overflows the frame and scrolls.
  expect(maxWidthOf(scroll().props.style)).toBe(260);
});

test("code block ScrollView is capped to the measured width too", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(MdText, { text: "```\na very long line of code goes here\n```" }),
    );
  });
  const layoutHost = tree.root.findAll(
    (n: TestRenderer.ReactTestInstance) => typeof n.props.onLayout === "function",
  )[0];
  fireLayout(layoutHost, 300);
  expect(maxWidthOf(tree.root.findAllByType(ScrollView)[0].props.style)).toBe(300);
});

/* ------------------------------------------------------------ column widths
   Columns must be sized once for the whole table (so rows align), fit their
   widest typical value, and let a rare outlier wrap instead of dragging the
   column wide. */

function cells(...texts: string[]): Span[][] {
  return texts.map(parseInline);
}

test("every cell in a column gets the same fixed width", () => {
  const table =
    "| Date | Item | Amount |\n|---|---|---|\n" +
    "| 25 Jun | TST*ULA, San Francisco | USD 198.22 |\n" +
    "| 3 Jul | Netflix, Mumbai | ₹649.00 |";
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(MdText, { text: table }));
  });
  const rows = tree.root
    .findAllByType(ScrollView)[0]
    .findAll((n: TestRenderer.ReactTestInstance) => {
      if (typeof n.type !== "string") return false; // host elements only, no composite twins
      const s = StyleSheet.flatten(n.props.style ?? {}) as { flexDirection?: string };
      return s.flexDirection === "row";
    });
  expect(rows.length).toBe(3); // header + 2 body rows
  const widthsPerRow = rows.map((row) =>
    row.children
      .filter((ch): ch is TestRenderer.ReactTestInstance => typeof ch !== "string")
      .map((cell) => (StyleSheet.flatten(cell.props.style) as { width?: number }).width),
  );
  expect(widthsPerRow[1]).toEqual(widthsPerRow[0]);
  expect(widthsPerRow[2]).toEqual(widthsPerRow[0]);
  for (const w of widthsPerRow[0]) expect(typeof w).toBe("number");
});

test("a column sizes to its widest typical value", () => {
  const [w] = columnWidths(cells("Amount"), [
    cells("₹18,741.70"),
    cells("₹3,810.80"),
    cells("₹1,531.48"),
  ]);
  // Fits the longest value on one line (10 chars ≈ 100px incl. padding).
  expect(w).toBeGreaterThanOrEqual(100);
  expect(w).toBeLessThan(140);
});

test("an outlier value wraps instead of widening the column", () => {
  const typical = columnWidths(cells("Item"), [
    cells("Netflix"),
    cells("PELAGO"),
    cells("YouTube"),
  ])[0];
  const withOutlier = columnWidths(cells("Item"), [
    cells("Netflix"),
    cells("PELAGO"),
    cells("YouTube"),
    cells("EMI The Store Plumb, Reno — USD 33.00 (24 installments)"),
  ])[0];
  // The outlier may nudge the column a little (p75 shifts) but must stay far
  // below the width that would fit it on one line (56 chars ≈ 470px).
  expect(withOutlier).toBeLessThan(200);
  expect(withOutlier).toBeGreaterThanOrEqual(typical);
});

test("a long header widens the column rather than wrapping", () => {
  const [w] = columnWidths(cells("Supported fee / GST"), [cells("₹67.47"), cells("₹2.95")]);
  // 19 header chars ≈ 172px incl. padding — the header must fit.
  expect(w).toBeGreaterThanOrEqual(19 * 8 + 20);
});

test("columns are clamped to sane bounds", () => {
  const [narrow] = columnWidths(cells("#"), [cells("1"), cells("2")]);
  expect(narrow).toBe(80); // MIN_COL floor
  const long = "x".repeat(200);
  const [wide] = columnWidths(cells("Text"), [cells(long), cells(long), cells(long)]);
  expect(wide).toBe(260); // MAX_COL ceiling — uniform long text still caps
});

test("chart modal navigates valid charts in one message and skips invalid fences", () => {
  const chart = (title: string) => `\`\`\`echarts\n${JSON.stringify({
    title: { text: title }, xAxis: { data: ["A", "B"] }, yAxis: {}, series: [{ type: "bar", data: [1, 2] }],
  })}\n\`\`\``;
  const text = [chart("Revenue"), "```echarts\n{ invalid json\n```", chart("Retention"), chart("Activation")].join("\n\n");
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(MdText, { text })); });
  expect(tree.root.findAllByProps({ children: "Could not render ECharts chart" }).length).toBeGreaterThan(0);
  act(() => labelled(tree.root, "Expand chart: Revenue").props.onPress());
  expect(labelled(tree.root, "Previous chart").props.accessibilityState.disabled).toBe(true);
  expect(tree.root.findByProps({ accessibilityLiveRegion: "polite" }).props.children).toEqual(["Chart ", 1, " of ", 3]);
  act(() => labelled(tree.root, "Next chart").props.onPress());
  expect(tree.root.findAllByProps({ children: "Retention" }).length).toBeGreaterThan(0);
  act(() => labelled(tree.root, "Next chart").props.onPress());
  expect(labelled(tree.root, "Next chart").props.accessibilityState.disabled).toBe(true);
  act(() => labelled(tree.root, "Previous chart").props.onPress());
  expect(tree.root.findAllByProps({ children: "Retention" }).length).toBeGreaterThan(0);
  act(() => labelled(tree.root, "Close chart").props.onPress());
  expect(tree.root.findAll((node) => node.props.accessibilityViewIsModal === true)).toHaveLength(0);
  act(() => tree.unmount());
});

test("chart modal closes when the message text changes", () => {
  const chart = (title: string) => `\`\`\`echarts\n${JSON.stringify({
    title: { text: title }, xAxis: { data: ["A"] }, yAxis: {}, series: [{ type: "bar", data: [1] }],
  })}\n\`\`\``;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(MdText, { text: chart("Before") })); });
  act(() => labelled(tree.root, "Expand chart: Before").props.onPress());
  expect(labelled(tree.root, "Close chart")).toBeDefined();
  act(() => tree.update(React.createElement(MdText, { text: chart("After") })));
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close chart")).toHaveLength(0);
  act(() => tree.unmount());
});
