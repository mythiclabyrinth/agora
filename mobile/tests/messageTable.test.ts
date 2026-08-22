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
        actions: [],
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

test("grid and footer share the card content-box width while wide content overflows", () => {
  const tree = render();
  const wrap = tree.root.findByProps({ testID: "message-table" });
  const scroll = tree.root.findByProps({ testID: "message-table-scroll" });
  const footer = tree.root.findByProps({ testID: "table-footer" });
  const scrollStyle = StyleSheet.flatten(scroll.props.style);
  const footerStyle = StyleSheet.flatten(footer.props.style);

  // A percentage width resolves against the parent's content box, excluding
  // its padding and border. Both siblings therefore occupy the same frame.
  expect(scrollStyle.width).toBe("100%");
  expect(scrollStyle.alignSelf).toBe("stretch");
  expect(footerStyle.width).toBe(scrollStyle.width);
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
