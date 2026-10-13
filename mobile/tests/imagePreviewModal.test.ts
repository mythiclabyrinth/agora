import { clampZoom, fitImageToViewport, zoomAtPoint } from "../src/components/imageZoomMath";

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  const builder = () => {
    const value: any = {};
    for (const method of ["onBegin", "onStart", "onUpdate", "onFinalize", "onEnd"]) {
      value[method] = (callback: (...args: any[]) => unknown) => { value[method] = callback; return value; };
    }
    value.maxPointers = () => value;
    value.numberOfTaps = () => value;
    return value;
  };
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children, gesture }: any) => React.createElement(View, { gesture }, children),
    Gesture: { Pinch: builder, Pan: builder, Tap: builder, Simultaneous: (...gestures: any[]) => gestures },
  };
});
jest.mock("lucide-react-native", () => ({ ChevronLeft: () => null, ChevronRight: () => null, X: () => null }));

describe("image zoom math", () => {
  test("zooms toward a focal point and respects the image edges", () => {
    const zoomed = zoomAtPoint({ scale: 1, x: 0, y: 0 }, 2, 100, 50, 100, 50, 300, 200, 300, 200);
    expect(zoomed).toEqual({ scale: 2, x: -100, y: -50 });
    expect(clampZoom({ scale: 5, x: 1000, y: -1000 }, 300, 200, 300, 200)).toEqual({ scale: 5, x: 600, y: -400 });
    expect(clampZoom({ scale: 2, x: 80, y: 180 }, 100, 200, 300, 200)).toEqual({ scale: 2, x: 0, y: 100 });
  });

  test("keeps the zoomed image under a pinch focal point that drifts", () => {
    expect(zoomAtPoint({ scale: 1, x: 0, y: 0 }, 2, 100, 50, 130, 70, 300, 200, 300, 200))
      .toEqual({ scale: 2, x: -70, y: -30 });
  });

  test("limits zoom to fit and five times", () => {
    expect(clampZoom({ scale: 0.5, x: 12, y: 12 }, 300, 200, 300, 200)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampZoom({ scale: 9, x: 0, y: 0 }, 300, 200, 300, 200).scale).toBe(5);
    expect(zoomAtPoint({ scale: 1, x: 0, y: 0 }, 0.8, 0, 0, 0, 0, 300, 200, 300, 200, 0.8).scale).toBe(0.8);
  });

  test("fits natural dimensions inside the viewport after layout changes", () => {
    expect(fitImageToViewport(1600, 900, 300, 600)).toEqual({ width: 300, height: 168.75 });
    expect(fitImageToViewport(1600, 900, 900, 300).width).toBeCloseTo(533.3333);
    expect(fitImageToViewport(1600, 900, 900, 300).height).toBe(300);
    expect(fitImageToViewport(0, 900, 300, 600)).toEqual({ width: 0, height: 0 });
  });
});

describe("image preview modal controls", () => {
  test("keeps gallery navigation and close buttons available", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const onPrevious = jest.fn();
    const onNext = jest.fn();
    const onClose = jest.fn();
    let tree: any;
    const props = {
      source: { uri: "https://example.test/image.png" }, filename: "one.png", index: 0, total: 2,
      onPrevious, onNext, onClose,
    };
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const press = (label: string) => {
      const button = tree.root.find((node: any) => node.props.accessibilityLabel === label);
      act(() => button.props.onPress());
    };
    press("Next image");
    press("Close image preview");
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const pinch = detector.props.gesture[0];
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => { pinch.onStart({ focalX: 200, focalY: 100 }); pinch.onUpdate({ scale: 2, focalX: 200, focalY: 100 }); });
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    act(() => pinch.onUpdate({ scale: 2, focalX: 230, focalY: 120 }));
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    const imageFrame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(imageFrame.props.style[1].transform[2].scale).toBe(2);
    expect(imageFrame.props.style[1].transform[0].translateX).toBe(-20);
    expect(imageFrame.props.style[1].transform[1].translateY).toBe(20);
    const nextImage = { ...props, filename: "same-source-second.png", index: 1 };
    act(() => tree.update(React.createElement(ImagePreviewModal, nextImage)));
    act(() => tree.update(React.createElement(ImagePreviewModal, nextImage)));
    const resetFrame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(resetFrame.props.style[1].transform[2].scale).toBe(1);
    act(() => tree.unmount());
  });

  test("uses the loaded aspect ratio when pinch and pan clamp the fitted image", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/wide.png" }, filename: "wide.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const [pinch, pan] = detector.props.gesture;
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "wide.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 600 } } }));
    act(() => image.props.onLoad({ source: { width: 1600, height: 900 } }));
    act(() => {
      pinch.onStart({ focalX: 150, focalY: 300 });
      pinch.onUpdate({ scale: 4, focalX: 150, focalY: 300 });
    });
    act(() => {
      pan.onBegin();
      pan.onUpdate({ translationX: 1_000, translationY: 1_000 });
      tree.update(React.createElement(ImagePreviewModal, props));
    });
    const imageFrame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(imageFrame.props.style[1].transform[1].translateY).toBeCloseTo((168.75 * 4 - 600) / 2);
    act(() => tree.unmount());
  });

  test("double tap toggles between fit and 2.5x at the tapped point", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/tap.png" }, filename: "tap.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const doubleTap = detector.props.gesture[2];
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "tap.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => image.props.onLoad({ source: { width: 300, height: 200 } }));
    act(() => doubleTap.onEnd({ x: 200, y: 100 }));
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    let frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform[2].scale).toBe(2.5);
    act(() => doubleTap.onEnd({ x: 200, y: 100 }));
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    act(() => tree.unmount());
  });

  test("springs an under-fit pinch back to 1x with zero offsets", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/pinch.png" }, filename: "pinch.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const pinch = detector.props.gesture[0];
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "pinch.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => image.props.onLoad({ source: { width: 300, height: 200 } }));
    act(() => { pinch.onStart({ focalX: 150, focalY: 100 }); pinch.onUpdate({ scale: 0.8, focalX: 150, focalY: 100 }); });
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    let frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform[2].scale).toBe(0.8);
    act(() => pinch.onFinalize());
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    act(() => tree.unmount());
  });

  test("normalizes a near-fit pinch so double tap zooms in", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/tiny-pinch.png" }, filename: "tiny-pinch.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const [pinch, , doubleTap] = detector.props.gesture;
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "tiny-pinch.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => image.props.onLoad({ source: { width: 300, height: 200 } }));
    act(() => {
      pinch.onStart({ focalX: 150, focalY: 100 });
      pinch.onUpdate({ scale: 1.004, focalX: 150, focalY: 100 });
      pinch.onFinalize();
    });
    act(() => doubleTap.onEnd({ x: 150, y: 100 }));
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    const frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform[2].scale).toBe(2.5);
    act(() => tree.unmount());
  });

  test("pan at fit leaves the image offsets unchanged", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/fit-pan.png" }, filename: "fit-pan.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const pan = detector.props.gesture[1];
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "fit-pan.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => image.props.onLoad({ source: { width: 300, height: 200 } }));
    act(() => { pan.onBegin(); pan.onUpdate({ translationX: 120, translationY: -80 }); });
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    const frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    act(() => tree.unmount());
  });

  test("pan end after an under-fit pinch clears the offsets", () => {
    const React = require("react");
    const TestRenderer = require("react-test-renderer");
    const { act } = TestRenderer;
    const { ImagePreviewModal } = require("../src/components/ImagePreviewModal");
    const props = { source: { uri: "https://example.test/pan-after-pinch.png" }, filename: "pan-after-pinch.png", onClose: jest.fn() };
    let tree: any;
    act(() => { tree = TestRenderer.create(React.createElement(ImagePreviewModal, props)); });
    const detector = tree.root.find((node: any) => Array.isArray(node.props.gesture));
    const [pinch, pan] = detector.props.gesture;
    const viewport = tree.root.find((node: any) => typeof node.props.onLayout === "function");
    const image = tree.root.find((node: any) => node.props.accessibilityLabel === "pan-after-pinch.png");
    act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 300, height: 200 } } }));
    act(() => image.props.onLoad({ source: { width: 300, height: 200 } }));
    act(() => {
      pinch.onStart({ focalX: 150, focalY: 100 });
      pinch.onUpdate({ scale: 0.8, focalX: 150, focalY: 100 });
      pan.onEnd();
    });
    act(() => tree.update(React.createElement(ImagePreviewModal, props)));
    const frame = tree.root.find((node: any) => Array.isArray(node.props.style) && node.props.style[1]?.transform);
    expect(frame.props.style[1].transform[0].translateX).toBe(0);
    expect(frame.props.style[1].transform[1].translateY).toBe(0);
    act(() => tree.unmount());
  });
});
