import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text, View } from "react-native";
import { fmtLastReply, fmtRelative } from "@agora/core";
import { ThreadInboxFooter, ThreadRelativeTime } from "../src/components/ThreadTimeMeta";

it("shows only the relative activity time in the top row", () => {
  const timestamp = 1_790_000_000;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadRelativeTime, { timestamp })); });
  expect(tree.root.findByType(Text).props.children).toBe(fmtRelative(timestamp));
  act(() => tree.unmount());
});

it("shows the accessible compact last-reply label in the footer beside replies", () => {
  const now = new Date(2026, 8, 28, 18, 0).getTime();
  const lastReplyTs = new Date(2025, 8, 28, 14, 15).getTime() / 1000;
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
  try {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => { tree = TestRenderer.create(React.createElement(ThreadInboxFooter, {
      replyCount: 3, unread: 2, lastReplyTs,
    })); });
    const footer = tree.root.findByProps({ testID: "thread-inbox-footer" });
    const texts = footer.findAllByType(Text);
    const lastReply = texts.find(text => text.props.accessibilityLabel);
    expect(texts[0].props.children.join("")).toBe("3 replies");
    expect(texts[1].props.children).toBe(2);
    expect(lastReply).toBeDefined();
    expect(lastReply?.props.children).toEqual([
      "Last reply at ", fmtLastReply(lastReplyTs, now, { compact: true }),
    ]);
    expect(footer.findAllByType(Text)).toContain(lastReply);
    expect(lastReply?.props.accessibilityLabel).toContain("2025");
    expect(lastReply?.props.numberOfLines).toBe(1);
    expect(lastReply?.props.maxFontSizeMultiplier).toBe(1.2);
    const labelStyle = StyleSheet.flatten(lastReply?.props.style);
    expect(labelStyle.fontSize).toBe(9.5);
    expect(labelStyle.marginLeft).toBe("auto");
    expect(labelStyle.textAlign).toBe("right");
    act(() => tree.unmount());
  } finally {
    nowSpy.mockRestore();
  }
});

it.each([Number.POSITIVE_INFINITY, Number.NaN, 0])("omits invalid reply timestamp %s", (ts) => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadInboxFooter, {
    replyCount: 3, unread: 0, lastReplyTs: ts,
  })); });
  expect(tree.root.findAll((node) => Boolean(node.props.accessibilityLabel))).toHaveLength(0);
  act(() => tree.unmount());
});

it("omits the last-reply line when there are no replies", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadInboxFooter, {
    replyCount: 0, unread: 0, lastReplyTs: 1_790_000_000,
  })); });
  expect(tree.root.findAll((node) => Boolean(node.props.accessibilityLabel))).toHaveLength(0);
  act(() => tree.unmount());
});
