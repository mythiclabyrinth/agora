import React from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useSession } from "../src/state/session";

import { createThemedStyles, useAppTheme } from "../src/lib/useTheme";

export default function Index() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const status = useSession((s) => s.status);
  if (status === "loading") {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.a1} />
      </View>
    );
  }
  return <Redirect href={status === "signedIn" ? "/(app)" : "/connect"} />;
}

const useStyles = createThemedStyles(({ colors }) => ({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
}));
