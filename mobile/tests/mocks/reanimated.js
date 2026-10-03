const { View } = require("react-native");

// Minimal stand-in: reanimated 4 needs the native worklets runtime, absent in jest.
module.exports = { __esModule: true, default: { View }, useAnimatedStyle: updater => updater() };
