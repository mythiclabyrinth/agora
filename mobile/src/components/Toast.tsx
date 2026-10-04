/* Toasts, ported from the desktop shim: transient, dismissible, warn
   variant. A zustand store so any hook/mutation can raise one. */

import React, { useEffect, useRef, useState } from "react";
import { Animated, Keyboard, Platform, Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { create } from "zustand";

import { createThemedStyles } from "../lib/useTheme";
import { Icon } from "./Icon";

interface ToastItem {
  id: number;
  message: string;
  variant?: "warn";
  action?: { label: string; onPress: () => void };
}

interface ToastState {
  items: ToastItem[];
  show: (message: string, variant?: "warn", action?: ToastItem["action"]) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  items: [],
  show(message, variant, action) {
    // Action toasts carry distinct callbacks (such as Undo for a thread).
    // Keep each one even when its visible message matches another toast.
    const existing = action ? undefined : get().items.find(
      (t) => !t.action && t.message === message && t.variant === variant,
    );
    if (existing) {
      // Refresh auto-dismiss by replacing with a new id.
      const id = nextId++;
      set((s) => ({
        items: s.items.map((t) => (t.id === existing.id ? { ...t, id, action } : t)),
      }));
      setTimeout(() => {
        set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
      }, 6000);
      return;
    }
    const id = nextId++;
    set((s) => ({ items: [...s.items, { id, message, variant, action }] }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
    }, 6000);
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
  },
}));

export function toast(message: string, variant?: "warn") {
  useToasts.getState().show(message, variant);
}

export function toastAction(message: string, label: string, onPress: () => void) {
  useToasts.getState().show(message, undefined, { label, onPress });
}

/** `${msg}: ${detail}` warn toast — the desktop's agoErr. */
export function toastErr(msg: string, e: unknown) {
  const detail = e instanceof Error ? e.message : String(e);
  toast(`${msg}: ${detail}`, "warn");
}

function ToastCard({ item }: { item: ToastItem }) {
  const styles = useStyles();
  const dismiss = useToasts((s) => s.dismiss);
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [opacity]);
  return (
    <Animated.View style={[styles.toast, item.variant === "warn" && styles.warn, { opacity }]}>
      <Text style={styles.msg} numberOfLines={4}>
        {item.message}
      </Text>
      {item.action && <Pressable accessibilityRole="button" accessibilityLabel={item.action.label}
        onPress={() => { dismiss(item.id); item.action?.onPress(); }}>
        <Text style={styles.action}>{item.action.label}</Text>
      </Pressable>}
      <Pressable onPress={() => dismiss(item.id)} hitSlop={8}>
        <Icon icon={X} size={14} />
      </Pressable>
    </Animated.View>
  );
}

/* The host is absolutely positioned at the screen bottom, which the software
   keyboard covers — an error toast raised while typing would be invisible. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

export function ToastHost() {
  const styles = useStyles();
  const items = useToasts((s) => s.items);
  const keyboardHeight = useKeyboardHeight();
  if (items.length === 0) return null;
  return (
    <View style={[styles.host, { bottom: 90 + keyboardHeight }]} pointerEvents="box-none">
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => ({
  host: {
    position: "absolute",
    bottom: 90,
    left: 16,
    right: 16,
    gap: 8,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: 480,
    backgroundColor: colors.sheet,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  warn: { borderColor: colors.dangerBorder },
  msg: { color: colors.text, fontSize: 13.5, flexShrink: 1 },
  action: { color: colors.a1, fontSize: 13.5, fontWeight: "800" },
}));
