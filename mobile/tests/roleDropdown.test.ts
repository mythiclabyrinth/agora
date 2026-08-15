import React from "react";
import TestRenderer, { act } from "react-test-renderer";
jest.mock("lucide-react-native", () => ({ Check: "Check", ChevronDown: "ChevronDown", ChevronUp: "ChevronUp" }));
import { RoleDropdown } from "../src/components/RoleDropdown";

test("shows the current role and switches immediately from the dropdown", () => {
  const onChange = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(RoleDropdown, { value: "member", onChange })); });

  expect(tree.root.findByProps({ accessibilityLabel: "Role: member" })).toBeTruthy();
  act(() => tree.root.findByProps({ accessibilityLabel: "Role: member" }).props.onPress());
  const options = tree.root.findAll(node => node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function");
  act(() => options[1].props.onPress());

  expect(onChange).toHaveBeenCalledWith("admin");
});
