import React from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Image, type ImageSource } from "expo-image";
import { ChevronLeft, ChevronRight, X } from "lucide-react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "./Icon";
import { clampZoom, fitImageToViewport, zoomAtPoint, type ImageZoom } from "./imageZoomMath";

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
  const sourceKey = typeof source === "number" ? `asset:${source}` : typeof source === "string" ? source : source.uri ?? JSON.stringify(source);
  const imageKey = `${index ?? ""}:${sourceKey}`;
  const gallery = index !== undefined && total !== undefined && total > 1;
  /* The modal covers the status bar and safe-area context is not always
     populated inside a native Modal, so floor the corner gap: without it the
     close button lands under the clock, flush with the screen edge. */
  const closeTop = Math.max(insets.top, Platform.OS === "ios" ? 44 : 16) + 8;
  const closeRight = Math.max(insets.right, 0) + 16;
  const scale = useSharedValue(1);
  const targetScale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const pinchStartFocalX = useSharedValue(0);
  const pinchStartFocalY = useSharedValue(0);
  const stageWidth = useSharedValue(1);
  const stageHeight = useSharedValue(1);
  const naturalWidth = useSharedValue(0);
  const naturalHeight = useSharedValue(0);
  const imageWidth = useSharedValue(1);
  const imageHeight = useSharedValue(1);
  const fitImage = React.useCallback(() => {
    const fitted = fitImageToViewport(naturalWidth.value, naturalHeight.value, stageWidth.value, stageHeight.value);
    if (fitted.width > 0 && fitted.height > 0) {
      imageWidth.value = fitted.width;
      imageHeight.value = fitted.height;
    } else {
      imageWidth.value = stageWidth.value;
      imageHeight.value = stageHeight.value;
    }
    const bounded = clampZoom({ scale: scale.value, x: offsetX.value, y: offsetY.value }, imageWidth.value, imageHeight.value, stageWidth.value, stageHeight.value);
    offsetX.value = bounded.x;
    offsetY.value = bounded.y;
  }, [imageHeight, imageWidth, naturalHeight, naturalWidth, offsetX, offsetY, scale, stageHeight, stageWidth]);
  React.useLayoutEffect(() => {
    scale.value = 1;
    targetScale.value = 1;
    offsetX.value = 0;
    offsetY.value = 0;
    naturalWidth.value = 0;
    naturalHeight.value = 0;
    fitImage();
  }, [fitImage, imageKey, naturalHeight, naturalWidth, offsetX, offsetY, scale, targetScale]);
  const applyZoom = React.useCallback((next: ImageZoom) => {
    targetScale.value = next.scale;
    scale.value = withSpring(next.scale);
    offsetX.value = withSpring(next.x);
    offsetY.value = withSpring(next.y);
  }, [offsetX, offsetY, scale, targetScale]);
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offsetX.value }, { translateY: offsetY.value }, { scale: scale.value }],
  }));
  const pinch = Gesture.Pinch()
    .onStart((event) => {
      startScale.value = scale.value;
      pinchStartX.value = offsetX.value;
      pinchStartY.value = offsetY.value;
      pinchStartFocalX.value = event.focalX;
      pinchStartFocalY.value = event.focalY;
    })
    .onUpdate((event) => {
      const nextScale = Math.max(0.8, Math.min(5, startScale.value * event.scale));
      const centerX = stageWidth.value / 2;
      const centerY = stageHeight.value / 2;
      const bounded = zoomAtPoint(
        { scale: startScale.value, x: pinchStartX.value, y: pinchStartY.value },
        nextScale,
        pinchStartFocalX.value - centerX,
        pinchStartFocalY.value - centerY,
        event.focalX - centerX,
        event.focalY - centerY,
        imageWidth.value,
        imageHeight.value,
        stageWidth.value,
        stageHeight.value,
        0.8,
      );
      targetScale.value = bounded.scale;
      scale.value = bounded.scale;
      offsetX.value = bounded.x;
      offsetY.value = bounded.y;
    })
    .onFinalize(() => {
      if (scale.value < 1.01) {
        scale.value = withSpring(1);
        targetScale.value = 1;
        offsetX.value = withSpring(0);
        offsetY.value = withSpring(0);
      }
    });
  const pan = Gesture.Pan()
    .maxPointers(1)
    .onBegin(() => { startX.value = offsetX.value; startY.value = offsetY.value; })
    .onUpdate((event) => {
      if (scale.value <= 1 || targetScale.value <= 1) return;
      const bounded = clampZoom({ scale: targetScale.value, x: startX.value + event.translationX, y: startY.value + event.translationY }, imageWidth.value, imageHeight.value, stageWidth.value, stageHeight.value);
      offsetX.value = bounded.x;
      offsetY.value = bounded.y;
    })
    .onEnd(() => {
      if (scale.value <= 1 || targetScale.value <= 1) {
        offsetX.value = withSpring(0);
        offsetY.value = withSpring(0);
      }
    });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd((event) => {
    const nextScale = scale.value > 1 ? 1 : 2.5;
    runOnJS(applyZoom)(zoomAtPoint(
      { scale: scale.value, x: offsetX.value, y: offsetY.value },
      nextScale,
      event.x - stageWidth.value / 2,
      event.y - stageHeight.value / 2,
      event.x - stageWidth.value / 2,
      event.y - stageHeight.value / 2,
      imageWidth.value,
      imageHeight.value,
      stageWidth.value,
      stageHeight.value,
    ));
  });
  const gestures = Gesture.Simultaneous(pinch, pan, doubleTap);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
       <View style={styles.root} accessibilityViewIsModal>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss image preview"
          style={styles.backdrop} onPress={onClose} />
        <View style={[styles.content, {
          paddingTop: Math.max(12, insets.top), paddingBottom: Math.max(12, insets.bottom),
          paddingLeft: Math.max(20, insets.left), paddingRight: Math.max(20, insets.right),
        }]}>
          <GestureDetector gesture={gestures}>
            <Animated.View style={styles.imageViewport} onLayout={(event) => {
              stageWidth.value = event.nativeEvent.layout.width;
              stageHeight.value = event.nativeEvent.layout.height;
              fitImage();
            }}>
              <Animated.View style={[styles.imageTransform, zoomStyle]}>
                <Image key={imageKey} source={source} style={styles.image} contentFit="contain" accessible
                  accessibilityLabel={filename} onLoad={(event) => {
                    naturalWidth.value = event.source.width;
                    naturalHeight.value = event.source.height;
                    fitImage();
                  }} />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
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
        {/* Outside the padded content view so the gap is measured from the
            screen edge, not from the image's own padding. */}
        <Pressable accessibilityRole="button" accessibilityLabel="Close image preview" hitSlop={12}
          style={({ pressed }) => [styles.close, { top: closeTop, right: closeRight }, pressed && styles.pressed]}
          onPress={onClose}>
          <Icon icon={X} size={22} color="#fff" />
        </Pressable>
       </View>
      </GestureHandlerRootView>
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
    position: "absolute", zIndex: 2, width: 44, height: 44,
    borderRadius: 22, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,22,30,0.92)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.25)",
  },
  image: { flex: 1, width: "100%" },
  imageViewport: { flex: 1, width: "100%", overflow: "hidden", alignItems: "center", justifyContent: "center" },
  imageTransform: { flex: 1, width: "100%" },
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
