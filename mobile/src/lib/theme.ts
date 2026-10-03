/* Palette distilled from web/src/styles.css so the app matches the web UI. */
export const colors = {
  bg: "#07090f",
  panel: "rgba(255,255,255,0.028)",
  panelStrong: "rgba(255,255,255,0.05)",
  /** Opaque foreground for sheets/modals rendered over a translucent scrim. */
  sheet: "#14161d",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.13)",
  text: "#eceef4",
  dim: "#8b91a5",
  faint: "#5b6072",
  a1: "#8b7cff",
  a2: "#38e1c8",
  green: "#4ade80",
  amber: "#fbbf24",
  red: "#f87171",
  // Solid stand-ins where RN can't do CSS gradients.
  accent: "#8b7cff",
  onAccent: "#0a0c14",
} as const;

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
} as const;

export const control = { minTouchSize: 44 } as const;

export const mono = { fontFamily: "Menlo" } as const;
