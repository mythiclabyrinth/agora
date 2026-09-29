import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text, View } from "react-native";
import { fmtLastReply } from "@agora/core";
import { ThreadTimeMeta } from "../src/components/ThreadTimeMeta";

it("shows the relative time above a compact accessible last-reply label", () => {
  const now = new Date(2026, 8, 28, 18, 0).getTime();
  const lastReplyTs = new Date(2025, 8, 28, 14, 15).getTime() / 1000;
  const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
  try {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => { tree = TestRenderer.create(React.createElement(ThreadTimeMeta, {
      relativeTs: now / 1000 - 300, lastReplyTs, replyCount: 3,
    })); });
    const texts = tree.root.findAllByType(Text);
    expect(texts[0].props.children).toBe("5m");
    expect(texts[1].props.children).toEqual(["Last reply at ", fmtLastReply(lastReplyTs, now, { compact: true })]);
    expect(texts[1].props.accessibilityLabel).toContain("2025");
    expect(texts[1].props.numberOfLines).toBe(1);
    expect(texts[1].props.maxFontSizeMultiplier).toBe(1.2);
    expect(StyleSheet.flatten(texts[1].props.style).fontSize).toBe(9.5);
    expect(StyleSheet.flatten(tree.root.findByType(View).props.style).maxWidth).toBe(180);
    act(() => tree.unmount());
  } finally {
    nowSpy.mockRestore();
  }
});

it.each([Number.POSITIVE_INFINITY, Number.NaN, 0])("omits invalid reply timestamp %s", (ts) => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadTimeMeta, {
    relativeTs: 1_790_000_000, lastReplyTs: ts, replyCount: 3,
  })); });
  expect(tree.root.findAllByType(Text)).toHaveLength(1);
  act(() => tree.unmount());
});

it("omits the last-reply line when there are no replies", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(ThreadTimeMeta, {
    relativeTs: 1_790_000_000, lastReplyTs: 1_790_000_000, replyCount: 0,
  })); });
  expect(tree.root.findAllByType(Text)).toHaveLength(1);
  act(() => tree.unmount());
});
