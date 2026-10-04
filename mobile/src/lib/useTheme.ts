import { createContext, useContext } from "react";
import { StyleSheet } from "react-native";
import { themes, type AppTheme } from "./theme";

export const AppThemeContext = createContext<AppTheme>(themes.dark);
export function useAppTheme() { return useContext(AppThemeContext); }

/** Evaluate recipes for the active palette, not once at module import. Context
 * updates preserve component identity, navigation, scroll positions and drafts. */
export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(factory: (theme: AppTheme) => T) {
  const cache = new WeakMap<AppTheme, T>();
  return function useStyles(): T {
    const theme = useAppTheme();
    let styles = cache.get(theme);
    if (!styles) { styles = StyleSheet.create(factory(theme)); cache.set(theme, styles); }
    return styles;
  };
}
