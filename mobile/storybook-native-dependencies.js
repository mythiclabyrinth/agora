module.exports = [
  // JS-only today, but keep the Storybook peer explicitly excluded if it
  // gains a native entry point in a future release.
  "@gorhom/bottom-sheet",
  "@react-native-async-storage/async-storage",
  "@react-native-community/datetimepicker",
  "@react-native-community/slider",
  // react-native-gesture-handler, -reanimated and -worklets are NOT listed:
  // the app itself imports them (root layout, SwipeRow), so they must
  // autolink in production builds too.
];
