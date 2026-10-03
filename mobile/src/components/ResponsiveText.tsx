import React from "react";
import { Text, useWindowDimensions, type TextProps } from "react-native";

/** Recreate the native text measurement when iOS changes Dynamic Type live.
 * Only the label remounts; the surrounding screen, drafts and scroll state stay put. */
export function ResponsiveText(props: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <Text key={fontScale} {...props} />;
}
