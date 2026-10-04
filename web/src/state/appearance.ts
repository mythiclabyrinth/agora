import { create } from "zustand";

export type Appearance = "light" | "dark" | "system";
export type ColorTheme = Exclude<Appearance, "system">;
export const APPEARANCE_KEY = "agora_appearance";

export function validAppearance(value: unknown): Appearance {
  return value === "light" || value === "system" ? value : "dark";
}

function savedAppearance(): Appearance {
  try { return validAppearance(localStorage.getItem(APPEARANCE_KEY)); }
  catch { return "dark"; }
}

function resolve(appearance: Appearance): ColorTheme {
  return appearance === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : appearance;
}

function apply(theme: ColorTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#07090f" : "#f5f6fa");
}

const initial = savedAppearance();
export const useAppearance = create<{
  preference: Appearance;
  resolved: ColorTheme;
  setPreference: (preference: Appearance) => void;
}>((set) => ({
  preference: initial,
  resolved: resolve(initial),
  setPreference: preference => {
    try { localStorage.setItem(APPEARANCE_KEY, preference); } catch { /* Private/managed browsers can deny storage. */ }
    const resolved = resolve(preference);
    apply(resolved);
    set({ preference, resolved });
  },
}));

/** Subscribe once at the application boundary; changing appearance never remounts chats or drafts. */
export function syncAppearance(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const refresh = (preference = useAppearance.getState().preference) => {
    const resolved = resolve(preference);
    apply(resolved);
    useAppearance.setState({ preference, resolved });
  };
  const systemChanged = () => refresh();
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === APPEARANCE_KEY || event.key === null)) refresh(savedAppearance());
  };
  refresh();
  media.addEventListener("change", systemChanged);
  window.addEventListener("storage", storageChanged);
  return () => {
    media.removeEventListener("change", systemChanged);
    window.removeEventListener("storage", storageChanged);
  };
}
