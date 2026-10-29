import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { wheelToRunAt } from "@agora/core";
import { DateTimeWheel, WHEEL_ROW } from "../src/components/DateTimeWheel";
import { defaultCustomTime, ScheduleSheet } from "../src/components/ScheduleSheet";

jest.mock("lucide-react-native", () => new Proxy({}, {
  get: () => function MockIcon() { return null; },
}));

jest.mock("@react-native-community/datetimepicker", () => {
  const mockReact = require("react");
  const { View: MockView } = require("react-native");
  const Picker = (props: object) => mockReact.createElement(MockView, props);
  return { __esModule: true, default: Picker };
});

function find(root: TestRenderer.ReactTestInstance, pred: (p: Record<string, unknown>) => boolean) {
  return root.find((node) => typeof node.type !== "string" && pred(node.props));
}
const column = (root: TestRenderer.ReactTestInstance, label: string) =>
  find(root, (p) => p.accessibilityRole === "adjustable" && p.accessibilityLabel === label);
const scroller = (root: TestRenderer.ReactTestInstance, label: string) =>
  find(root, (p) => p.testID === `wheel-${label}` && typeof p.onMomentumScrollEnd === "function");
const land = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, velocity: { x: 0, y: 0 } } });

// Thu 29 Oct 2026, 14:10 local.
const now = new Date(2026, 9, 29, 14, 10).getTime();

test("the custom time opens on the next whole local hour", () => {
  expect(defaultCustomTime(now)).toEqual(new Date(2026, 9, 29, 15, 0));
});

test("the iOS picker keeps its minimum date while open and refreshes it on reopening", () => {
  const os = Platform.OS;
  Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
  jest.useFakeTimers();
  jest.setSystemTime(now);
  let tree: TestRenderer.ReactTestRenderer | undefined;
  try {
    const render = (visible: boolean, pending = false) => React.createElement(SafeAreaProvider,
      { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 44, bottom: 34, left: 0, right: 0 } } },
      React.createElement(ScheduleSheet, { visible, pending, presets: [60, 180], onClose: jest.fn(), onSchedule: jest.fn() }),
    );
    act(() => { tree = TestRenderer.create(render(true)); });
    const openCustom = () => act(() => find(tree!.root, p => p.accessibilityLabel === "Custom time").props.onPress());
    const picker = () => find(tree!.root, p => p.testID === "schedule-custom-picker");
    openCustom();
    const initialMinimum = picker().props.minimumDate;
    expect(initialMinimum.getTime()).toBe(now);

    jest.setSystemTime(now + 60_000);
    act(() => picker().props.onChange({}, new Date(now + 3_600_000)));
    expect(picker().props.minimumDate).toBe(initialMinimum);
    act(() => tree!.update(render(true, true)));
    expect(picker().props.minimumDate).toBe(initialMinimum);

    act(() => tree!.update(render(false)));
    jest.setSystemTime(now + 7_200_000);
    act(() => tree!.update(render(true)));
    openCustom();
    expect(picker().props.minimumDate).not.toBe(initialMinimum);
    expect(picker().props.minimumDate.getTime()).toBe(now + 7_200_000);
  } finally {
    if (tree) act(() => tree!.unmount());
    jest.useRealTimers();
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  }
});

test("each wheel column maps to day, hour, minute and AM/PM in local time", () => {
  let value = new Date(2026, 9, 29, 16, 0);
  const onChange = jest.fn((d: Date) => { value = d; });
  let tree!: TestRenderer.ReactTestRenderer;
  const render = () => React.createElement(DateTimeWheel, { value, onChange, nowMs: now });
  act(() => { tree = TestRenderer.create(render()); });
  expect(column(tree.root, "Day").props.accessibilityValue).toEqual({ text: "Today" });
  expect(column(tree.root, "Hour").props.accessibilityValue).toEqual({ text: "4" });
  expect(column(tree.root, "AM or PM").props.accessibilityValue).toEqual({ text: "PM" });

  // A fling that lands three rows down picks the day three days on.
  act(() => scroller(tree.root, "Day").props.onMomentumScrollEnd(land(3 * WHEEL_ROW)));
  expect(value).toEqual(new Date(2026, 10, 1, 16, 0));
  act(() => tree.update(render()));
  expect(column(tree.root, "Day").props.accessibilityValue).toEqual({ text: "Sun Nov 1" });

  // A slow drag release settles too; 12 on the hour column is noon in PM.
  act(() => scroller(tree.root, "Hour").props.onScrollEndDrag(land(11 * WHEEL_ROW)));
  expect(value).toEqual(new Date(2026, 10, 1, 12, 0));
  act(() => tree.update(render()));

  // Screen-reader increment steps a column; tapping a row picks it.
  act(() => column(tree.root, "Minute").props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(value).toEqual(new Date(2026, 10, 1, 12, 1));
  act(() => tree.update(render()));
  const am = tree.root.findAll((n) => n.props.children === "AM" && typeof n.props.onPress === "function")[0];
  act(() => am.props.onPress());
  expect(value).toEqual(new Date(2026, 10, 1, 0, 1));
  expect(Math.round(value.getTime() / 1000)).toBe(wheelToRunAt({ day: 3, hour12: 12, minute: 1, pm: false }, now));
  act(() => tree.unmount());
});

describe("on Android", () => {
  const os = Platform.OS;
  beforeAll(() => { Object.defineProperty(Platform, "OS", { value: "android", configurable: true }); });
  afterAll(() => { Object.defineProperty(Platform, "OS", { value: os, configurable: true }); });

  test("Custom time shows the wheel and schedules what it picks", () => {
    const onSchedule = jest.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(SafeAreaProvider, { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 44, bottom: 34, left: 0, right: 0 } } }, React.createElement(ScheduleSheet, {
        visible: true, presets: [60, 180], onClose: jest.fn(), onSchedule,
      })));
    });
    act(() => find(tree.root, (p) => p.accessibilityLabel === "Custom time").props.onPress());
    expect(tree.root.findAll((n) => n.props.testID === "schedule-wheel").length).toBeGreaterThan(0);
    expect(tree.root.findAllByType(Text).some((t) => /^Date, /.test(String(t.props.accessibilityLabel ?? "")))).toBe(false);
    const opened = defaultCustomTime();
    const submit = () => find(tree.root, (p) => p.accessibilityLabel === "Schedule message" && p.accessibilityRole === "button");
    // Scheduling must wait for the visible wheel selection to settle.
    act(() => scroller(tree.root, "Minute").props.onScrollBeginDrag());
    expect(submit().props.disabled).toBe(true);
    act(() => submit().props.onPress());
    expect(onSchedule).not.toHaveBeenCalled();
    act(() => scroller(tree.root, "Minute").props.onMomentumScrollEnd(land(30 * WHEEL_ROW)));
    expect(submit().props.disabled).toBe(false);
    act(() => find(tree.root, (p) => p.accessibilityLabel === "Schedule message" && p.accessibilityRole === "button").props.onPress());
    expect(onSchedule).toHaveBeenCalledTimes(1);
    const expected = new Date(opened);
    expected.setMinutes(30);
    expect(onSchedule.mock.calls[0][0]).toBe(Math.round(expected.getTime() / 1000));
    act(() => tree.unmount());
  });
});

test("a release with velocity but no momentum events still settles the wheel", () => {
  jest.useFakeTimers();
  try {
    let value = new Date(2026, 9, 29, 16, 0);
    const onChange = jest.fn((d: Date) => { value = d; });
    const onSettlingChange = jest.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(DateTimeWheel, { value, onChange, nowMs: now, onSettlingChange }));
    });
    const day = scroller(tree.root, "Day");
    act(() => day.props.onScrollBeginDrag());
    expect(onSettlingChange).toHaveBeenLastCalledWith(true);
    act(() => day.props.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0, y: 2 * WHEEL_ROW }, velocity: { x: 0, y: 1.2 } } }));
    act(() => { jest.advanceTimersByTime(500); });
    expect(onSettlingChange).toHaveBeenLastCalledWith(false);
    expect(value).toEqual(new Date(2026, 9, 31, 16, 0));
  } finally {
    jest.useRealTimers();
  }
});
