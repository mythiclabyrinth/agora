import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Platform, Text } from "react-native";
import { wheelToRunAt } from "@agora/core";
import { DateTimeWheel, WHEEL_ROW } from "../src/components/DateTimeWheel";
import { defaultCustomTime, ScheduleSheet } from "../src/components/ScheduleSheet";

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
  expect(defaultCustomTime(now)).toEqual(new Date(2026, 9, 29, 16, 0));
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
      tree = TestRenderer.create(React.createElement(ScheduleSheet, {
        visible: true, presets: [60, 180], onClose: jest.fn(), onSchedule,
      }));
    });
    act(() => find(tree.root, (p) => p.accessibilityLabel === "Custom time").props.onPress());
    expect(tree.root.findAll((n) => n.props.testID === "schedule-wheel").length).toBeGreaterThan(0);
    expect(tree.root.findAllByType(Text).some((t) => /^Date, /.test(String(t.props.accessibilityLabel ?? "")))).toBe(false);
    const opened = defaultCustomTime();
    act(() => scroller(tree.root, "Minute").props.onMomentumScrollEnd(land(30 * WHEEL_ROW)));
    act(() => find(tree.root, (p) => p.accessibilityLabel === "Schedule message" && p.accessibilityRole === "button").props.onPress());
    expect(onSchedule).toHaveBeenCalledTimes(1);
    const expected = new Date(opened);
    expected.setMinutes(30);
    expect(onSchedule.mock.calls[0][0]).toBe(Math.round(expected.getTime() / 1000));
    act(() => tree.unmount());
  });
});
