import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Appearance, Text, TextInput, StyleSheet } from "react-native";
import { DarkTheme, useTheme } from "expo-router";
import { AppThemeProvider, navigationTheme } from "../src/components/AppThemeProvider";
import { colors, themes } from "../src/lib/theme";
import { usePrefs } from "../src/state/prefs";
import { createThemedStyles } from "../src/lib/useTheme";
import { AppearancePicker } from "../src/components/AppearancePicker";
jest.mock("lucide-react-native", () => ({ Monitor: "Monitor", Moon: "Moon", Sun: "Sun" }));

// Exercise the real theme context without loading the unrelated navigation
// engine, whose ESM entry isn't part of this test suite's native mocks.
jest.mock("expo-router", () => ({
  ...jest.requireActual("expo-router/build/react-navigation/native/theming/DarkTheme"),
  ...jest.requireActual("expo-router/build/react-navigation/native/theming/DefaultTheme"),
  ...jest.requireActual("expo-router/build/react-navigation/core/theming/ThemeProvider"),
  ...jest.requireActual("expo-router/build/react-navigation/core/theming/useTheme"),
}));

beforeEach(() => { usePrefs.setState({ loaded: true, appearance: "dark" }); });

test("switches navigation, fields and recipes without losing an unsent draft", () => {
  const useStyles = createThemedStyles(({ colors }) => ({ input: { color: colors.text, backgroundColor: colors.panel } }));
  function Draft() {
    const styles = useStyles();
    const [value, onChangeText] = React.useState("Unsent message");
    return React.createElement(TextInput, { testID: "draft", value, onChangeText, style: styles.input });
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(AppThemeProvider, null,
    React.createElement(ThemeProbe), React.createElement(Draft), React.createElement(AppearancePicker))); });
  act(() => tree.root.findByProps({ testID: "draft" }).props.onChangeText("Keep this draft"));
  for (const mode of ["light", "dark"] as const) {
    act(() => tree.root.findAllByProps({ accessibilityLabel: `${mode === "light" ? "Light" : "Dark"} theme` })[0].props.onPress());
    const field = tree.root.findByProps({ testID: "draft" });
    expect(field.props.value).toBe("Keep this draft");
    expect(StyleSheet.flatten(field.props.style)).toEqual({ color: themes[mode].colors.text, backgroundColor: themes[mode].colors.panel });
    expect(JSON.parse(tree.root.findByProps({ testID: "theme" }).props.children).dark).toBe(mode === "dark");
    expect(usePrefs.getState().appearance).toBe(mode);
  }
  const nativeAppearance = jest.spyOn(Appearance, "setColorScheme");
  act(() => usePrefs.getState().setAppearance("system"));
  expect(nativeAppearance).toHaveBeenCalledWith("unspecified");
  nativeAppearance.mockRestore();
  act(() => tree.unmount());
});

function ThemeProbe() {
  const theme = useTheme();
  return React.createElement(Text, { testID: "theme" }, JSON.stringify(theme));
}

test("navigation inherits the centralized dark palette, including native header appearance", () => {
  expect(navigationTheme.dark).toBe(true);
  expect(navigationTheme.fonts).toEqual(DarkTheme.fonts);
  expect(navigationTheme.colors).toEqual({ primary: colors.a1, background: colors.bg, card: colors.bg,
    text: colors.text, border: colors.border, notification: colors.red });
});

test("screens continue to receive the dark navigation theme after unmounting and returning", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  const screen = () => React.createElement(AppThemeProvider, null, React.createElement(ThemeProbe));
  act(() => { tree = TestRenderer.create(screen()); });
  expect(JSON.parse(tree.root.findByProps({ testID: "theme" }).props.children).dark).toBe(true);
  act(() => tree.update(React.createElement(AppThemeProvider)));
  act(() => tree.update(screen()));
  expect(JSON.parse(tree.root.findByProps({ testID: "theme" }).props.children)).toEqual(navigationTheme);
  act(() => tree.unmount());
});
