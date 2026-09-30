import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { SelectDropdown } from "../src/components/SelectDropdown";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

it("closes without writing when the selected option is tapped", () => {
  const onToggle = jest.fn();
  const onChange = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(SelectDropdown, {
      label: "Group", value: "product", open: true,
      options: [{ value: "product", label: "Product" }, { value: "design", label: "Design" }],
      onToggle, onChange,
    }));
  });
  const product = tree.root.findByProps({ accessibilityRole: "menuitem", accessibilityLabel: "Product" });
  act(() => product.props.onPress());
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
