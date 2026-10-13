import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform, type LayoutChangeEvent } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useHeaderKeyboardAvoiding } from "../src/lib/keyboard";

function render(iosOffset?: number) {
  const out: { current: ReturnType<typeof useHeaderKeyboardAvoiding> | null } = { current: null };
  function Probe() {
    out.current = useHeaderKeyboardAvoiding(iosOffset);
    return null;
  }
  act(() => {
    TestRenderer.create(
      React.createElement(SafeAreaProvider, {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, right: 0, bottom: 34, left: 0 },
        },
      }, React.createElement(Probe)),
    );
  });
  return out;
}

function layoutEvent(frameY: number, windowY: number): LayoutChangeEvent {
  return {
    nativeEvent: { layout: { x: 0, y: frameY, width: 390, height: 700 } },
    target: { measureInWindow: (cb: (x: number, y: number) => void) => cb(0, windowY) },
  } as unknown as LayoutChangeEvent;
}

describe("useHeaderKeyboardAvoiding", () => {
  it("iOS pads by the status bar plus the 44pt nav bar, or an explicit offset", () => {
    expect(render().current).toEqual({ behavior: "padding", keyboardVerticalOffset: 47 + 44 });
    expect(render(92).current).toEqual({ behavior: "padding", keyboardVerticalOffset: 92 });
  });

  describe("Android (edge-to-edge: the window never resizes for the IME)", () => {
    let restore: jest.ReplaceProperty<typeof Platform.OS>;
    beforeEach(() => { restore = jest.replaceProperty(Platform, "OS", "android"); });
    afterEach(() => restore.restore());

    it("pads, offset by the parent's measured window position", () => {
      const out = render();
      expect(out.current?.behavior).toBe("padding");
      expect(out.current?.keyboardVerticalOffset).toBe(0);
      act(() => out.current?.onLayout?.(layoutEvent(0, 80)));
      expect(out.current?.keyboardVerticalOffset).toBe(80);
    });

    it("falls back to status bar + app bar when the view can't be measured", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const out = render();
      act(() => out.current?.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } },
        target: {},
      } as unknown as LayoutChangeEvent));
      expect(out.current?.keyboardVerticalOffset).toBe(47 + 56);
      warn.mockRestore();
    });

    it("doesn't count the view's own parent-relative frame twice", () => {
      const out = render();
      act(() => out.current?.onLayout?.(layoutEvent(40, 120)));
      expect(out.current?.keyboardVerticalOffset).toBe(80);
    });
  });

  it("leaves other platforms (web) alone", () => {
    const restore = jest.replaceProperty(Platform, "OS", "web");
    try {
      expect(render().current).toEqual({});
    } finally {
      restore.restore();
    }
  });
});
