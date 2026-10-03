import React, { forwardRef, useState } from "react";
import { TextInput, StyleSheet, type TextInputProps } from "react-native";
import { colors, surfaces, typography } from "../lib/theme";

/** Native editing semantics and refs, with consistent focus and disabled states.
 * The composer keeps its own native input because it owns intrinsic sizing. */
export const ThemedInput = forwardRef<TextInput, TextInputProps>(function ThemedInput(
  { style, onFocus, onBlur, editable = true, placeholderTextColor = colors.faint, selectionColor = colors.a1, ...props }, ref,
) {
  const [focused, setFocused] = useState(false);
  return <TextInput {...props} ref={ref} editable={editable}
    placeholderTextColor={placeholderTextColor} selectionColor={selectionColor}
    style={[styles.field, style, styles.skin, focused && styles.focused, !editable && styles.disabled]}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }} />;
});
const styles = StyleSheet.create({
  field: { ...surfaces.field, ...typography.message },
  skin: { backgroundColor: surfaces.field.backgroundColor, color: colors.text,
    borderColor: surfaces.field.borderColor, borderWidth: surfaces.field.borderWidth, borderRadius: surfaces.field.borderRadius },
  focused: { borderColor: colors.a1 },
  disabled: { opacity: 0.5 },
});
