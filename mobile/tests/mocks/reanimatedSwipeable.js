const React = require("react");
const { View } = require("react-native");

module.exports = React.forwardRef((props, ref) => {
  React.useImperativeHandle(ref, () => ({
    close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn(),
  }));
  return React.createElement(View, {
    testID: props.testID || "mock-swipe", onSwipeableWillOpen: props.onSwipeableWillOpen,
    onSwipeableClose: props.onSwipeableClose,
  }, props.renderLeftActions?.(), props.children, props.renderRightActions?.());
});
