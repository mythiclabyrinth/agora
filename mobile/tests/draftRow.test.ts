import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { router } from "expo-router";
import { draftSync, type DraftRow } from "@agora/core";
import { DraftInboxRow } from "../app/(app)/inbox";

jest.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock("../app/(app)/threads", () => ({ ThreadsScreen: () => null }));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));
jest.mock("../src/components/SwipeRow", () => ({
  SwipeRow: ({ children, onPress, swipeLeft }: React.PropsWithChildren<{ onPress: () => void; swipeLeft: { onPress: () => void } }>) =>
    require("react").createElement("mock-swipe", { onPress, swipeLeft }, children),
  useSwipeRows: () => ({ close: jest.fn() }),
}));
const row: DraftRow = { channel_id: "general", thread_id: 42, body: "hello", meta: { addressed: [], reply_in_thread: false },
  rev: 1, client_id: "other", updated_at: 1, channel_name: "general", group_id: "team", group_name: "Team", thread_title: "Plan" };

test("draft row opens the thread and swipe discards the matching key", () => {
  const discard = jest.spyOn(draftSync, "discard").mockResolvedValue(true);
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(DraftInboxRow, { item: row, controller: { close: jest.fn() } as never })); });
  const swipe = tree.root.findAll(node => (node.type as unknown) === "mock-swipe")[0];
  act(() => swipe.props.onPress());
  expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/(app)/thread/[channelId]/[rootId]" }));
  act(() => swipe.props.swipeLeft.onPress());
  expect(discard).toHaveBeenCalledWith("general:t42", 1);
  discard.mockRestore();
  act(() => tree.unmount());
});
