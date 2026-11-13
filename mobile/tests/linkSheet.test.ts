/* Long-press a link in a message: a sheet with Open in Browser, Copy Link
   and Share, instead of the message's own actions. */

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)), StringFormat: { PLAIN_TEXT: "plainText", HTML: "html" } }));
jest.mock("../src/components/Toast", () => ({ toast: jest.fn(), toastErr: jest.fn() }));
jest.mock("../src/lib/openLink", () => ({ openLink: jest.fn(), openLinkOrThrow: jest.fn(() => Promise.resolve()) }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Share, Text } from "react-native";
import * as Clipboard from "expo-clipboard";
import { parseInline } from "@agora/core";
import { MdText } from "../src/components/MdText";
import { DISMISS_MS, LinkActionsSheet, linkSheetTitle } from "../src/components/LinkActionsSheet";
import { openLink, openLinkOrThrow } from "../src/lib/openLink";
import { toast } from "../src/components/Toast";

const URL = "https://github.com/appsmithorg/kite/pull/29632";
const press = { stopPropagation: jest.fn() };

beforeEach(() => jest.clearAllMocks());

function render(text: string, onLongPress = jest.fn(), onPress = jest.fn()) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(MdText, { text, onLongPress, onPress })); });
  return tree;
}
const link = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.find(node => node.type === Text && node.props.accessibilityRole === "link");
const sheet = (tree: TestRenderer.ReactTestRenderer) => tree.root.findAllByType(LinkActionsSheet);
const textOf = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(node => node.props.children).flat().filter(c => typeof c === "string");

test("long-pressing a link opens its sheet, not the message actions or the link", () => {
  const onLongPress = jest.fn();
  const onPress = jest.fn();
  const tree = render(`See [PR #29632](${URL}) for details`, onLongPress, onPress);
  expect(sheet(tree)).toHaveLength(0);
  act(() => link(tree).props.onLongPress(press));
  expect(sheet(tree)).toHaveLength(1);
  expect(sheet(tree)[0].props.link).toEqual({ text: "PR #29632", url: URL });
  expect(textOf(tree)).toEqual(expect.arrayContaining(["PR #29632", URL, "Open in Browser", "Copy Link", "Share…"]));
  expect(onLongPress).not.toHaveBeenCalled();
  expect(onPress).not.toHaveBeenCalled();
  expect(openLink).not.toHaveBeenCalled();
  act(() => sheet(tree)[0].props.onClose());
  expect(sheet(tree)).toHaveLength(0);
});

test("tapping a link still opens it the usual way, and other text keeps the message long-press", () => {
  const onLongPress = jest.fn();
  const tree = render(`Look ${URL}`, onLongPress);
  act(() => link(tree).props.onPress(press));
  expect(openLink).toHaveBeenCalledWith(URL);
  const paragraph = tree.root.find(node => node.type === Text && node.props.onLongPress === onLongPress);
  act(() => paragraph.props.onLongPress());
  expect(onLongPress).toHaveBeenCalledTimes(1);
  expect(sheet(tree)).toHaveLength(0);
});

test("a bare URL is named once; only http(s) text becomes a link", () => {
  expect(linkSheetTitle({ text: URL, url: URL })).toBeNull();
  expect(linkSheetTitle({ text: "PR #1", url: URL })).toBe("PR #1");
  expect(parseInline("write to mailto:me@example.com").some(span => span.kind === "link")).toBe(false);
});

test("links in table cells reach the sheet too", () => {
  const tree = render(`| PR |\n|---|\n| [#1](${URL}) |`);
  act(() => link(tree).props.onLongPress(press));
  expect(sheet(tree)[0].props.link).toEqual({ text: "#1", url: URL });
});

test("the sheet's actions open in the chosen browser, copy, and share once it has closed", async () => {
  jest.useFakeTimers();
  const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" } as never);
  const onClose = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(LinkActionsSheet, { link: { text: "PR", url: URL }, onClose })); });
  const row = (label: string) => tree.root.find(node => node.props.accessibilityLabel === label && typeof node.props.onPress === "function");
  const run = async (label: string) => {
    await act(async () => row(label).props.onPress());
    // Nothing is presented while the sheet is still fading out (iOS refuses).
    expect(onClose).toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(DISMISS_MS); });
  };
  await run("Open in Browser");
  expect(openLinkOrThrow).toHaveBeenCalledWith(URL, { nativeApps: false });
  await run("Copy Link");
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(URL);
  expect(toast).toHaveBeenCalledWith("Link copied.");
  await act(async () => row("Share…").props.onPress());
  expect(share).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(DISMISS_MS); });
  // iOS shares the URL once (not again as message text).
  expect(share).toHaveBeenCalledWith({ url: URL });
  expect(onClose).toHaveBeenCalledTimes(3);
  // Touching the sheet body (to read or select the URL) doesn't close it.
  const stop = jest.fn();
  act(() => tree.root.find(node => node.props.accessibilityViewIsModal).props.onPress({ stopPropagation: stop }));
  expect(stop).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(3);
  act(() => tree.unmount());
  jest.useRealTimers();
});
