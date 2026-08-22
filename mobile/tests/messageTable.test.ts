jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type Message, type Session } from "@agora/core";
import { MessageTable } from "../src/components/MessageTable";
import {
  INTERACTIVE_COL_GUTTER,
  MAX_COL,
  actionButtonWidth,
  actionColumnLayout,
  interactiveColumnWidth,
} from "../src/lib/tableLayout";

const session: Session = { baseUrl: "http://test", token: "t" };
const message: Message = {
  id: 81,
  channel_id: "expenses",
  thread_id: null,
  author_type: "agent",
  author_id: "hermes",
  author_name: "Hermes",
  text: "Review the missing transaction.",
  ts: 1_787_376_900,
  attachments: [],
  meta: {
    table: {
      columns: [
        { id: "title", label: "Title", kind: "text" },
        { id: "merchant", label: "Merchant", kind: "text" },
        { id: "amount", label: "Amount", kind: "number" },
      ],
      rows: [{
        id: "txn_1",
        cells: { title: "HMS Host Services India", merchant: "HMS Host Services India Pvt Ltd", amount: 1028 },
        actions: [
          { id: "approve", label: "Approve", style: "primary" },
          { id: "reject", label: "Reject", style: "secondary" },
        ],
      }],
      buttons: [{ id: "approve_all", label: "Approve all", style: "primary" }],
    },
  },
};

function width(node: TestRenderer.ReactTestInstance): number {
  return (StyleSheet.flatten(node.props.style) as { width: number }).width;
}

function render() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(
          ApiProvider,
          { client: new ApiClient(session) },
          React.createElement(MessageTable, { message }),
        ),
      ),
    );
  });
  return tree;
}

test("header and editable cells share aligned outer widths and gutters", () => {
  const tree = render();
  for (const id of ["title", "merchant", "amount"]) {
    const header = tree.root.findByProps({ testID: `table-header-${id}` });
    const cell = tree.root.findByProps({ testID: `table-cell-txn_1-${id}` });
    expect(width(cell)).toBe(width(header));
    expect(StyleSheet.flatten(header.props.style).paddingHorizontal).toBe(INTERACTIVE_COL_GUTTER);
    expect(StyleSheet.flatten(cell.props.style).paddingHorizontal).toBe(INTERACTIVE_COL_GUTTER);
  }
});

test("editable inputs can shrink to the shell content width without overlap", () => {
  const tree = render();
  const shell = tree.root.findByProps({ testID: "table-cell-txn_1-merchant" });
  const input = tree.root.findByProps({ testID: "table-input-txn_1-merchant" });
  const shellStyle = StyleSheet.flatten(shell.props.style);
  const inputStyle = StyleSheet.flatten(input.props.style);
  expect(shellStyle.paddingHorizontal).toBe(INTERACTIVE_COL_GUTTER);
  expect(inputStyle.flex).toBe(1);
  expect(inputStyle.minWidth).toBe(0);
  expect(width(shell) - INTERACTIVE_COL_GUTTER * 2).toBeGreaterThan(0);
});

test("row actions use label-driven columns and 44pt tap targets", () => {
  const tree = render();
  const approve = tree.root.findByProps({ testID: "table-action-txn_1-approve" });
  const approveStyle = StyleSheet.flatten(approve.props.style);
  expect(approveStyle.minHeight).toBeGreaterThanOrEqual(44);
  expect(approveStyle.width).toBeGreaterThanOrEqual(actionButtonWidth("Approve"));
  const reject = tree.root.findByProps({ testID: "table-action-txn_1-reject" });
  expect(StyleSheet.flatten(reject.props.style).width).toBeGreaterThanOrEqual(
    actionButtonWidth("Reject"),
  );
  const compact = actionColumnLayout(["Approve", "Reject"]);
  expect(compact.horizontal).toBe(true);
  expect(compact.width).toBeGreaterThan(112);
  const long = actionColumnLayout(["Approve & notify accounting", "Reject permanently"]);
  expect(long.horizontal).toBe(false);
  expect(long.width).toBeLessThanOrEqual(MAX_COL);
});

test("grid and footer share the card content-box width while wide content overflows", () => {
  const tree = render();
  const wrap = tree.root.findByProps({ testID: "message-table" });
  const scroll = tree.root.findByProps({ testID: "message-table-scroll" });
  const grid = tree.root.findByProps({ testID: "message-table-grid" });
  const header = tree.root.findByProps({ testID: "message-table-header" });
  const footer = tree.root.findByProps({ testID: "table-footer" });
  const scrollStyle = StyleSheet.flatten(scroll.props.style);
  const contentStyle = StyleSheet.flatten(scroll.props.contentContainerStyle);
  const gridStyle = StyleSheet.flatten(grid.props.style);
  const footerStyle = StyleSheet.flatten(footer.props.style);

  // A percentage width resolves against the parent's content box, excluding
  // its padding and border. Both siblings therefore occupy the same frame.
  expect(scrollStyle.width).toBe("100%");
  expect(scrollStyle.alignSelf).toBe("stretch");
  expect(footerStyle.width).toBe(scrollStyle.width);
  expect(contentStyle.minWidth).toBe(footerStyle.width);
  expect(gridStyle.minWidth).toBe(footerStyle.width);
  // The header has no fixed width of its own: its row layout stretches to
  // the grid's 100% minimum, so its painted strip reaches the footer edge.
  expect(StyleSheet.flatten(header.props.style).width).toBeUndefined();
  expect(scrollStyle.maxWidth).toBeUndefined();
  expect(wrap.props.onLayout).toBeUndefined();

  const total = ["title", "merchant", "amount"]
    .map((id) => width(tree.root.findByProps({ testID: `table-header-${id}` })))
    .reduce((sum, value) => sum + value, 112);
  expect(total).toBeGreaterThan(280); // content remains horizontally scrollable
});

test("footer is visibly separated from the scrollable grid", () => {
  const footer = render().root.findByProps({ testID: "table-footer" });
  const style = StyleSheet.flatten(footer.props.style);
  expect(style.borderTopWidth).toBeGreaterThan(0);
  expect(style.paddingTop).toBeGreaterThanOrEqual(8);
});

test("long interactive values remain capped after adding outer gutters", () => {
  expect(interactiveColumnWidth(900)).toBe(MAX_COL);
});

test("an explicit width describes the input content before outer gutters", () => {
  expect(interactiveColumnWidth(80, 100)).toBe(100 + INTERACTIVE_COL_GUTTER * 2);
  expect(interactiveColumnWidth(80, MAX_COL)).toBe(MAX_COL);
});
