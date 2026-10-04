import React, { useEffect, useMemo } from "react";
import { Appearance, useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { resolveTheme, themes, type AppTheme } from "../lib/theme";
import { AppThemeContext } from "../lib/useTheme";
import { usePrefs } from "../state/prefs";

// Header colors alone do not set the native appearance. In particular, iOS 26
// restores toolbar glass using the navigator's theme when popping a screen.
export function makeNavigationTheme(theme: AppTheme) {
  const colors = theme.colors;
  const base = theme.mode === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.a1,
      background: colors.bg,
      card: colors.bg,
      text: colors.text,
      border: colors.border,
      notification: colors.red,
    },
  };
}
export const navigationTheme = makeNavigationTheme(themes.dark);

export function AppThemeProvider({ children }: React.PropsWithChildren) {
  const preference = usePrefs(state => state.appearance);
  const loaded = usePrefs(state => state.loaded);
  const load = usePrefs(state => state.load);
  const system = useColorScheme();
  const theme = themes[resolveTheme(preference, system)];
  const navigation = useMemo(() => makeNavigationTheme(theme), [theme]);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  // Native alerts, keyboards and pickers follow the same preference. Clear the
  // override in System mode so future device appearance changes remain live.
  useEffect(() => { Appearance.setColorScheme(preference === "system" ? "unspecified" : preference); }, [preference]);
  useEffect(() => { void SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => {}); }, [theme]);
  return <AppThemeContext.Provider value={theme}><ThemeProvider value={navigation}>
    <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
    {children}
  </ThemeProvider></AppThemeContext.Provider>;
}
