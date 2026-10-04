import React, { forwardRef, useState } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { typography } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";

/** Native editing semantics and refs, with consistent focus and disabled states.
 * The composer keeps its own native input because it owns intrinsic sizing. */
export const ThemedInput = forwardRef<TextInput, TextInputProps>(function ThemedInput(
  { style, onFocus, onBlur, editable = true, placeholderTextColor, selectionColor, keyboardAppearance, ...props }, ref,
) {
  const { colors, mode } = useAppTheme();
  const styles = useStyles();
  const [focused, setFocused] = useState(false);
  return <TextInput {...props} ref={ref} editable={editable}
    placeholderTextColor={placeholderTextColor ?? colors.faint} selectionColor={selectionColor ?? colors.a1} keyboardAppearance={keyboardAppearance ?? mode}
    style={[styles.field, style, styles.skin, focused && styles.focused, !editable && styles.disabled]}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }} />;
});
const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  field: { ...surfaces.field, ...typography.message },
  skin: { backgroundColor: surfaces.field.backgroundColor, color: colors.text,
    borderColor: surfaces.field.borderColor, borderWidth: surfaces.field.borderWidth, borderRadius: surfaces.field.borderRadius },
  focused: { borderColor: colors.a1 },
  disabled: { opacity: 0.5 },
}));
