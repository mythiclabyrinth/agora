import { unreadSwipeAction } from "../app/(app)/inbox";
import { threadSwipeActions } from "../app/(app)/threads";
import type { ThreadRow, UnreadItem } from "@agora/core";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Redirect: () => null, Stack: { Screen: () => null }, router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock("../src/components/SwipeRow", () => ({ SwipeRow: () => null, useSwipeRows: () => ({ close: jest.fn() }) }));

it("marks the exact unread card from its left swipe action", () => {
  const item = { kind: "channel", channel_id: "main" } as UnreadItem;
  const onRead = jest.fn();
  const action = unreadSwipeAction(item, onRead);
  expect(action.name).toBe("markRead");
  action.onPress();
  expect(onRead).toHaveBeenCalledWith(item);
});

it("routes thread swipe directions to remove and rename", () => {
  const thread = { root: { id: 42 } } as ThreadRow;
  const onRename = jest.fn();
  const onRemove = jest.fn();
  const { swipeLeft, swipeRight } = threadSwipeActions(thread, onRename, onRemove);
  expect(swipeLeft.name).toBe("remove");
  expect(swipeRight.name).toBe("rename");
  swipeLeft.onPress();
  swipeRight.onPress();
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onRename).toHaveBeenCalledWith(thread);
});
