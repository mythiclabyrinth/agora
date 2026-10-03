const React = require("react");
const { View } = require("react-native");

module.exports = React.forwardRef((props, ref) => {
  const methods = { close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn() };
  React.useImperativeHandle(ref, () => methods);
  // Like the real component: actions get (progress, translation, methods), at rest = 0.
  const progress = { value: 0 };
  const translation = { value: 0 };
  return React.createElement(View, {
    testID: props.testID || "mock-swipe", onSwipeableWillOpen: props.onSwipeableWillOpen,
    onSwipeableClose: props.onSwipeableClose, onSwipeableOpenStartDrag: props.onSwipeableOpenStartDrag,
    style: props.containerStyle,
  }, props.renderLeftActions?.(progress, translation, methods),
  React.createElement(View, { testID: "mock-swipe-foreground", style: props.childrenContainerStyle }, props.children),
  props.renderRightActions?.(progress, translation, methods));
});
