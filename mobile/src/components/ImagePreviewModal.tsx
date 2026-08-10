import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image, type ImageSource } from "expo-image";
import { ChevronLeft, ChevronRight, X } from "lucide-react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { Icon } from "./Icon";

export function ImagePreviewModal({ source, filename, index, total, onPrevious, onNext, onClose }: {
  source: ImageSource;
  filename: string;
  index?: number;
  total?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const insets = React.useContext(SafeAreaInsetsContext) ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const gallery = index !== undefined && total !== undefined && total > 1;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss image preview"
          style={styles.backdrop} onPress={onClose} />
        <View style={[styles.content, {
          paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom),
          paddingLeft: Math.max(20, insets.left), paddingRight: Math.max(20, insets.right),
        }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close image preview"
            style={styles.close} onPress={onClose}>
            <Icon icon={X} size={22} color="#fff" />
          </Pressable>
          <Image key={filename} source={source} style={styles.image} contentFit="contain" accessible
            accessibilityLabel={filename} />
          {gallery ? (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous image"
                accessibilityState={{ disabled: index === 0 }} disabled={index === 0}
                style={({ pressed }) => [styles.navButton, styles.navPrev, { left: Math.max(10, insets.left) },
                  index === 0 && styles.disabled, pressed && styles.pressed]}
                onPress={onPrevious}>
                <Icon icon={ChevronLeft} size={24} color="#fff" />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Next image"
                accessibilityState={{ disabled: index === total - 1 }} disabled={index === total - 1}
                style={({ pressed }) => [styles.navButton, styles.navNext, { right: Math.max(10, insets.right) },
                  index === total - 1 && styles.disabled, pressed && styles.pressed]}
                onPress={onNext}>
                <Icon icon={ChevronRight} size={24} color="#fff" />
              </Pressable>
              <View style={[styles.counterPill, { bottom: Math.max(14, insets.bottom) }]} pointerEvents="none">
                <Text accessibilityLiveRegion="polite" style={styles.position}>Image {index + 1} of {total}</Text>
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
  backdrop: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: "rgba(4,6,10,0.92)",
  },
  content: {
    width: "100%", height: "100%", alignItems: "center",
    justifyContent: "center",
  },
  close: {
    position: "absolute", top: 0, right: 0, zIndex: 1, width: 44, height: 44,
    borderRadius: 22, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,22,30,0.92)",
  },
  image: { flex: 1, width: "100%" },
  navButton: {
    width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,22,30,0.82)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.25)",
  },
  navPrev: { position: "absolute", top: "50%", marginTop: -22, zIndex: 1 },
  navNext: { position: "absolute", top: "50%", marginTop: -22, zIndex: 1 },
  counterPill: {
    position: "absolute", alignSelf: "center", paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 999, backgroundColor: "rgba(20,22,30,0.82)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  position: { color: "#d1d5db", fontSize: 13, fontWeight: "600" },
});
