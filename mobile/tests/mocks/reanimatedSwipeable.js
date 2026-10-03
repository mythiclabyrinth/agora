const React = require("react");
const { View } = require("react-native");
let leftProgressValue = 0;
let rightProgressValue = 0;

exports.__setSwipeProgress = (left, right) => {
  leftProgressValue = left;
  rightProgressValue = right;
};

module.exports = Object.assign(React.forwardRef((props, ref) => {
  const methodsRef = React.useRef(null);
  methodsRef.current ||= { close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn() };
  const methods = methodsRef.current;
  React.useImperativeHandle(ref, () => methods, [methods]);
  // Like the real component: actions get (progress, translation, methods), at rest = 0.
  const leftProgress = { value: leftProgressValue };
  const rightProgress = { value: rightProgressValue };
  const translation = { value: 0 };
  return React.createElement(View, {
    testID: props.testID || "mock-swipe", onSwipeableWillOpen: props.onSwipeableWillOpen,
    onSwipeableClose: props.onSwipeableClose, onSwipeableOpenStartDrag: props.onSwipeableOpenStartDrag,
    onSwipeableCloseStartDrag: props.onSwipeableCloseStartDrag,
    style: props.containerStyle, testSwipeMethods: methods,
  }, props.renderLeftActions?.(leftProgress, translation, methods),
  React.createElement(View, { testID: "mock-swipe-foreground", style: props.childrenContainerStyle }, props.children),
  props.renderRightActions?.(rightProgress, translation, methods));
}), { __setSwipeProgress: exports.__setSwipeProgress });
