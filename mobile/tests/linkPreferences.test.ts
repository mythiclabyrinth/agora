import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { LinkPreferences } from "../src/components/LinkPreferences";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

function openMenu(tree: TestRenderer.ReactTestRenderer) {
  act(() => tree.root.findByProps({ accessibilityLabel: "Browser fallback: In-app browser" }).props.onPress());
}

it("reports browser selections and disables unavailable Chrome", () => {
  const change = jest.fn();
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "in-app",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: change,
      chromeAvailable: true,
    }));
  });
  expect(tree!.root.findAllByProps({ accessibilityRole: "menuitem" })).toHaveLength(0);
  openMenu(tree!);
  const radios = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function"
  );
  expect(radios).toHaveLength(3);
  act(() => radios[2].props.onPress());
  expect(change).toHaveBeenCalledWith("chrome");
  expect(tree!.root.findAllByProps({ accessibilityRole: "menuitem" })).toHaveLength(0);

  act(() => {
    tree!.update(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "in-app",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: change,
      chromeAvailable: false,
    }));
  });
  openMenu(tree!);
  const unavailable = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function"
  );
  expect(unavailable).toHaveLength(3);
  expect(unavailable[2].props.accessibilityState).toMatchObject({ disabled: true });
  change.mockClear();
  act(() => unavailable[2].props.onPress());
  expect(change).not.toHaveBeenCalled();
  act(() => tree!.unmount());
});

it("keeps a stored Chrome choice selected when Chrome is unavailable", () => {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "chrome",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: () => {},
      chromeAvailable: false,
    }));
  });
  act(() => tree!.root.findByProps({ accessibilityLabel: "Browser fallback: Chrome" }).props.onPress());
  const chrome = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "menuitem" &&
    typeof node.props.onPress === "function"
  )[2];
  expect(chrome.props.accessibilityState).toMatchObject({
    selected: true,
    disabled: true,
  });
  expect(JSON.stringify(tree!.toJSON())).toContain("Not installed");
  act(() => tree!.unmount());
});
