/* Entry-point swap for the on-device Storybook.

   withStorybook() in metro.config.js only wires up story generation and the
   channel server — it does NOT change what the app renders, so the switch has
   to happen here. `npm run storybook` sets EXPO_PUBLIC_STORYBOOK_ENABLED;
   plain `expo start` leaves it unset and boots the real app.

   The var must carry the EXPO_PUBLIC_ prefix: that is the only form Expo
   inlines into the JS bundle, and this branch is evaluated on-device. The
   inlined literal also lets Metro drop the Storybook require from production
   bundles as dead code. */

if (process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true") {
  if (!__DEV__) {
    throw new Error(
      "Storybook entry in a release bundle — unset EXPO_PUBLIC_STORYBOOK_ENABLED for production builds.",
    );
  }
  const { registerRootComponent } = require("expo");
  // storybook.requires exports `view`; index.tsx default-exports the UI root.
  // The disabled-path stub uses module.exports, hence the fallback.
  const entry = require("./.rnstorybook");
  registerRootComponent(entry.default || entry);
} else {
  require("./src/lib/notificationActionRuntime").installNotificationActionHandlers();
  require("expo-router/entry");
}
