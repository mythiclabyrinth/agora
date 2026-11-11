import React, { useContext, useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { SpeakingBanner, SpeakingScreen } from "../src/components/SpeakingBanner";
import { useNativeSpeech } from "../src/lib/nativeSpeech";

jest.mock("expo-speech", () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }), { virtual: true });
jest.mock("../src/lib/speech", () => ({ stopSpeech: jest.fn() }));
jest.mock("react-native-safe-area-context", () => {
  const { createContext, useContext } = jest.requireActual("react");
  const SafeAreaInsetsContext = createContext({ top: 47, bottom: 34, left: 0, right: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) };
});
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => function MockIcon() { return null; } }));

const native = jest.requireMock("expo-speech") as { stop: jest.Mock };
let tree: TestRenderer.ReactTestRenderer;
beforeEach(() => { jest.clearAllMocks(); act(() => useNativeSpeech.setState({ speaking: false })); });
afterEach(() => act(() => tree?.unmount()));
function render(element: React.ReactElement) { act(() => { tree = TestRenderer.create(element); }); }
function stopButton() {
  return tree.root.findAll((node) => node.props.accessibilityLabel === "Stop speaking" && typeof node.props.onPress === "function")[0];
}
/** The strip's own resolved style (its outer View), not anything in the tree. */
function stripStyle() {
  const label = tree.root.findAllByType(Text).find((t) => t.props.children === "Speaking message…")!;
  let node = label.parent;
  while (node && !(node.type === View && node.props.style && StyleSheet.flatten(node.props.style).borderBottomWidth === 1)) {
    node = node.parent;
  }
  return StyleSheet.flatten(node!.props.style);
}

test("renders nothing while no message is being spoken", () => {
  render(React.createElement(SpeakingBanner));
  expect(tree.toJSON()).toBeNull();
});

test("shows a Stop button that ends speech and hides the strip", () => {
  act(() => useNativeSpeech.setState({ speaking: true }));
  render(React.createElement(SpeakingBanner));
  expect(tree.root.findAllByType(Text).map((t) => t.props.children)).toContain("Speaking message…");
  act(() => stopButton().props.onPress());
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(tree.toJSON()).toBeNull();
});

/* Records the insets the wrapped screen sees, and counts its mounts. */
let mounts = 0;
let seenTop: number | undefined;
function Screen() {
  seenTop = useContext(SafeAreaInsetsContext)?.top;
  useEffect(() => { mounts++; }, []);
  return null;
}
function screen(headerShown: boolean) {
  return React.createElement(SpeakingScreen, { headerShown }, React.createElement(Screen));
}

test("under a native header the strip adds no status-bar padding and leaves insets alone", () => {
  mounts = 0;
  render(screen(true));
  act(() => useNativeSpeech.setState({ speaking: true }));
  expect(stripStyle().paddingTop).toBe(0);
  expect(seenTop).toBe(47);
  expect(mounts).toBe(1); // starting speech never remounts the screen
});

test("on a headerless screen the strip takes the status-bar inset from the screen", () => {
  mounts = 0;
  render(screen(false));
  expect(seenTop).toBe(47);
  act(() => useNativeSpeech.setState({ speaking: true }));
  expect(stripStyle().paddingTop).toBe(47);
  expect(seenTop).toBe(0);
  act(() => stopButton().props.onPress());
  expect(seenTop).toBe(47);
  expect(mounts).toBe(1);
});
