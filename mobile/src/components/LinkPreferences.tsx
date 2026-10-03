import React, { useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { isChromeAvailable } from "../lib/openLink";
import { colors, surfaces, typography, space } from "../lib/theme";
import { SelectDropdown } from "./SelectDropdown";
import type { LinkBrowser } from "../state/prefs";

export function LinkPreferences({
  preferNativeApps,
  browser,
  onPreferNativeAppsChange,
  onBrowserChange,
  chromeAvailable: givenChromeAvailable,
}: {
  preferNativeApps: boolean;
  browser: LinkBrowser;
  onPreferNativeAppsChange: (on: boolean) => void;
  onBrowserChange: (browser: LinkBrowser) => void;
  chromeAvailable?: boolean;
}) {
  const [detectedChrome, setDetectedChrome] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (givenChromeAvailable !== undefined) return;
    void isChromeAvailable().then(setDetectedChrome).catch(() => setDetectedChrome(false));
  }, [givenChromeAvailable]);
  const chromeAvailable = givenChromeAvailable ?? detectedChrome;
  const choices: {
    value: LinkBrowser;
    label: string;
    detail: string;
    disabled?: boolean;
  }[] = [
    { value: "in-app", label: "In-app browser", detail: "Stay inside Agora" },
    { value: "system", label: "System browser", detail: "Your device default" },
    {
      value: "chrome",
      label: "Chrome",
      detail: chromeAvailable ? "Open with Google Chrome" : "Not installed",
      disabled: !chromeAvailable,
    },
  ];

  return (
    <View style={styles.card}>
      <View style={styles.nativeRow}>
        <View style={styles.copy}>
          <Text style={styles.name}>Open supported links in apps</Text>
          <Text style={styles.meta}>Use Google Maps or YouTube when supported and installed.</Text>
        </View>
        <Switch
          accessibilityLabel="Open supported links in apps"
          value={preferNativeApps}
          onValueChange={onPreferNativeAppsChange}
          trackColor={{ false: colors.borderStrong, true: colors.a1 }}
        />
      </View>
      <View style={styles.browser}>
        <SelectDropdown label="Browser fallback" value={browser} options={choices}
          open={open} inlineMenu onToggle={() => setOpen(value => !value)}
          onChange={value => { setOpen(false); onBrowserChange(value); }} />
        <Text style={styles.meta}>{choices.find(choice => choice.value === browser)?.detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...surfaces.card, overflow: "hidden" },
  nativeRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  browser: { padding: space.lg, gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  copy: { flex: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.dim, fontSize: 12, marginTop: 2 },
});
