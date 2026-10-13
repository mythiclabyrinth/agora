const React = require("react");
const { View } = require("react-native");

// Minimal stand-in: reanimated 4 needs the native worklets runtime, absent in jest.
module.exports = {
  __esModule: true,
  default: { View },
  useAnimatedStyle: updater => updater(),
  useSharedValue: initial => {
    const value = React.useRef({ value: initial });
    return value.current;
  },
  withSpring: value => value,
  withTiming: value => value,
  runOnJS: callback => callback,
};
