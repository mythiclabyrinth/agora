/** Agora's mobile design system. Keep brand, semantic colors and component
 * recipes here so a future rebrand never requires editing individual screens. */
export const brand = {
  name: "Agora",
  tagline: "People & agents, together.",
  primary: "#8b7cff",
  secondary: "#38e1c8",
  primaryLight: "#6250ce",
  secondaryLight: "#087365",
  logo: require("../../assets/icon.png"),
} as const;

/** Derive all brand washes from these two colors, including embedded content. */
export function tint(hex: string, opacity: number) {
  const value = hex.replace("#", "");
  return `rgba(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)},${opacity})`;
}

export const colors = {
  bg: "#07090f",
  panel: "#10131b",
  panelStrong: "#252938",
  /** Opaque foreground for sheets/modals rendered over a translucent scrim. */
  sheet: "#191d28",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.13)",
  text: "#eceef4",
  dim: "#adb5c7",
  faint: "#919aaf",
  a1: brand.primary,
  a2: brand.secondary,
  green: "#4ade80",
  amber: "#fbbf24",
  red: "#f87171",
  accentSoft: tint(brand.primary, 0.14),
  accentBorder: tint(brand.primary, 0.32),
  accentWash: tint(brand.primary, 0.06),
  mintSoft: tint(brand.secondary, 0.08),
  mintBorder: tint(brand.secondary, 0.22),
  accentText: "#cfc8ff",
  ownMessage: "#28233f",
  scrim: "rgba(0,0,0,0.6)",
  mentionSurface: "#46282f",
  // Solid stand-ins where RN can't do CSS gradients.
  accent: brand.primary,
  onAccent: "#0a0c14",
  successSoft: "rgba(74,222,128,0.12)",
  successBorder: "rgba(74,222,128,0.3)",
  dangerSoft: "rgba(248,113,113,0.1)",
  dangerBorder: "rgba(248,113,113,0.3)",
  warningSoft: "rgba(251,191,36,0.08)",
  warningBorder: "rgba(251,191,36,0.35)",
  shadow: "#000000",
  neutralSoft: "rgba(255,255,255,0.05)",
  neutralStrong: "rgba(255,255,255,0.08)",
  info: "#6ecbf5",
  infoSoft: "rgba(54,197,240,0.13)",
} as const;

export type ThemeMode = "dark" | "light";
export type AppearancePreference = ThemeMode | "system";
export type Palette = { [K in keyof typeof colors]: string };
export const lightColors: Palette = {
  bg: "#f5f6fa", panel: "#ffffff", panelStrong: "#e9ebf2", sheet: "#ffffff",
  border: "rgba(24,32,51,0.10)", borderStrong: "rgba(24,32,51,0.20)",
  text: "#182033", dim: "#4f586b", faint: "#606878",
  a1: brand.primaryLight, a2: brand.secondaryLight,
  green: "#137d42", amber: "#8f6400", red: "#b52b40",
  accentSoft: tint(brand.primaryLight, 0.10), accentBorder: tint(brand.primaryLight, 0.28), accentWash: tint(brand.primaryLight, 0.05),
  mintSoft: tint(brand.secondaryLight, 0.08), mintBorder: tint(brand.secondaryLight, 0.22),
  accentText: "#5140b4", ownMessage: "#ece8ff", scrim: "rgba(16,24,40,0.36)", mentionSurface: "#ffe4e9",
  accent: brand.primaryLight, onAccent: "#ffffff",
  successSoft: "rgba(19,125,66,0.08)", successBorder: "rgba(19,125,66,0.30)",
  dangerSoft: "rgba(181,43,64,0.08)", dangerBorder: "rgba(181,43,64,0.30)",
  warningSoft: "rgba(143,100,0,0.08)", warningBorder: "rgba(143,100,0,0.30)", shadow: "#000000",
  neutralSoft: "rgba(24,32,51,0.04)", neutralStrong: "rgba(24,32,51,0.08)",
  info: "#146a99", infoSoft: "rgba(20,106,153,0.08)",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, section: 32 } as const;
export const radii = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;
// Keep the original scalar export compatible with existing screens.
export const radius = radii.lg;

export const weight = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

export const typography = {
  caption: { fontSize: 12, lineHeight: 16, fontWeight: weight.medium },
  meta: { fontSize: 13, lineHeight: 18, fontWeight: weight.regular },
  bodySm: { fontSize: 14, lineHeight: 20, fontWeight: weight.regular },
  message: { fontSize: 15, lineHeight: 22, fontWeight: weight.regular },
  body: { fontSize: 16, lineHeight: 24, fontWeight: weight.regular },
  title: { fontSize: 18, lineHeight: 24, fontWeight: weight.semibold },
  display: { fontSize: 28, lineHeight: 34, fontWeight: weight.bold },
  hero: { fontSize: 32, lineHeight: 38, fontWeight: weight.bold, letterSpacing: -1 },
  eyebrow: { fontSize: 11, lineHeight: 16, fontWeight: weight.semibold, letterSpacing: 1.5 },
} as const;

export const control = { minTouchSize: 44 } as const;
export const composerSizing = { minHeight: 40, maxHeight: 150 } as const;

/** Shared recipes; screen-specific layout belongs with its screen. */
export function createSurfaces(colors: Palette) { return {
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: radii.lg },
  field: { backgroundColor: colors.bg, borderColor: colors.borderStrong, borderWidth: 1, borderRadius: radii.md,
    minHeight: control.minTouchSize, paddingHorizontal: space.md, paddingVertical: space.md, color: colors.text },
  sheet: { backgroundColor: colors.sheet, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    borderWidth: 1, borderColor: colors.borderStrong, padding: space.xl, paddingBottom: space.section },
  primaryButton: { minHeight: control.minTouchSize, borderRadius: radii.md, backgroundColor: colors.accent,
    alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg, paddingVertical: space.md },
} as const; }

export const surfaces = createSurfaces(colors);
export const themes = {
  dark: { mode: "dark" as const, colors: colors as Palette, surfaces },
  light: { mode: "light" as const, colors: lightColors, surfaces: createSurfaces(lightColors) },
};
export type AppTheme = typeof themes.dark | typeof themes.light;
export function resolveTheme(preference: AppearancePreference, system: string | null | undefined): ThemeMode {
  return preference === "system" ? system === "light" ? "light" : "dark" : preference;
}

export const layout = { gutter: space.xl, sectionGap: space.xxl, contentBottom: space.section } as const;

export const mono = { fontFamily: "Menlo" } as const;
