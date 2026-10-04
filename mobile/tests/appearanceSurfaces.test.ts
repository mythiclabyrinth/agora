import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, TextInput } from "react-native";
import Connect from "../app/connect";
import { LiveVoiceView, type LiveStatus } from "../src/components/LiveVoice";
import { ThemedInput } from "../src/components/ThemedInput";
import { AppThemeContext } from "../src/lib/useTheme";
import { themes } from "../src/lib/theme";
import { mermaidHtml } from "../src/components/Mermaid";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({ useLocalSearchParams: () => ({}), Redirect: () => null }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../src/state/session", () => ({ useSession: () => ({ status: "signedOut", savedUrl: "", signIn: jest.fn() }) }));
jest.mock("../src/state/servers", () => ({ loadRecentServers: () => Promise.resolve([]), forgetRecentServer: jest.fn() }));

async function render(mode: "light" | "dark", child: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(React.createElement(AppThemeContext.Provider, { value: themes[mode] }, child)); });
  return tree;
}
describe.each(["light", "dark"] as const)("%s remaining appearance surfaces", mode => {
  test("signed-out connection screen and input inherit the active palette", async () => {
    const tree = await render(mode, React.createElement(Connect));
    const fields = tree.root.findAllByType(TextInput);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(StyleSheet.flatten(field.props.style).color).toBe(themes[mode].colors.text);
      expect(field.props.placeholderTextColor).toBe(themes[mode].colors.faint);
      expect(field.props.keyboardAppearance).toBe(mode);
    }
    act(() => tree.unmount());
  });
  test("focused editable fields keep theme-aware selection and placeholder colors", async () => {
    const tree = await render(mode, React.createElement(ThemedInput, { value: "Draft", placeholder: "Write a message" }));
    const field = tree.root.findByType(TextInput);
    expect(field.props.selectionColor).toBe(themes[mode].colors.a1);
    act(() => field.props.onFocus({ nativeEvent: {} }));
    expect(StyleSheet.flatten(tree.root.findByType(TextInput).props.style).borderColor).toBe(themes[mode].colors.a1);
    act(() => tree.unmount());
  });
  test.each(["starting", "listening", "recording", "thinking", "speaking", "error"] as LiveStatus[])("live voice %s can render without activating a recorder", async status => {
    const onEnd = jest.fn();
    const tree = await render(mode, React.createElement(LiveVoiceView, {
      channelLabel: "general", threadSession: false, status, muted: false, muteBusy: false, meteringDb: null,
      onInterrupt: jest.fn(), onToggleMute: jest.fn(), onEnd,
    }));
    expect(tree.toJSON()).toBeTruthy();
    expect(JSON.stringify(tree.toJSON())).toContain(themes[mode].colors.bg);
    expect(onEnd).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
  test("diagrams inherit appearance while preserving markup escaping", () => {
    const html = mermaidHtml("graph TD; A[<script>] --> B", themes[mode]);
    expect(html).toContain(`background: ${themes[mode].colors.bg}`);
    expect(html).toContain(`theme: "${mode === "dark" ? "dark" : "default"}"`);
    expect(html).toContain("&lt;script&gt;");
  });
});
