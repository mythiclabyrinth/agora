import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text, View } from "react-native";
import { fmtLastReply, fmtLastReplyFull, fmtRelative } from "@agora/core";
import { ThreadInboxFooter, ThreadRelativeTime } from "../src/components/ThreadTimeMeta";

it("shows only the relative activity time in the top row when the footer has the full date", () => {
  const timestamp = 1_790_000_000;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadRelativeTime, {
    timestamp, replyCount: 2, lastReplyTs: timestamp,
  })); });
  const label = tree.root.findByType(Text);
  expect(label.props.children).toBe(fmtRelative(timestamp));
  expect(label.props.accessibilityLabel).toBeUndefined();
  act(() => tree.unmount());
});

it("announces the full activity date when there is no footer reply time", () => {
  const timestamp = 1_790_000_000;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadRelativeTime, {
    timestamp, replyCount: 0, lastReplyTs: timestamp,
  })); });
  const label = tree.root.findByType(Text);
  expect(label.props.children).toBe(fmtRelative(timestamp));
  expect(label.props.accessibilityLabel).toBe(fmtLastReplyFull(timestamp));
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
    const fullLabel = `Last reply at ${fmtLastReplyFull(lastReplyTs)}`;
    const lastReply = tree.root.findByProps({ accessibilityLabel: fullLabel });
    expect(texts[0].props.children.join("")).toBe("3 replies");
    expect(texts[1].props.children).toBe(2);
    expect(lastReply).toBeDefined();
    expect(lastReply?.props.children).toEqual([
      "Last reply at ", fmtLastReply(lastReplyTs, now, { compact: true }),
    ]);
    expect(lastReply.parent?.props.testID).toBe("thread-inbox-footer");
    expect(lastReply?.props.accessibilityLabel).toContain("2025");
    expect(lastReply?.props.numberOfLines).toBe(1);
    expect(lastReply?.props.maxFontSizeMultiplier).toBe(1.2);
    const labelStyle = StyleSheet.flatten(lastReply?.props.style);
    expect(labelStyle.fontSize).toBe(12);
    expect(labelStyle.lineHeight).toBeGreaterThanOrEqual(labelStyle.fontSize);
    expect(labelStyle.marginLeft).toBe("auto");
    expect(labelStyle.textAlign).toBe("right");
    act(() => tree.unmount());
  } finally {
    nowSpy.mockRestore();
  }
});

it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1])("omits invalid reply timestamp %s", (ts) => {
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
