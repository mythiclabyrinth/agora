const mockPush = jest.fn();

jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

import type { SearchMessageHit } from "@agora/core";
import { openHit } from "../app/(app)/search";

const hit = (over: Partial<SearchMessageHit>) => ({
  id: 77,
  channel_id: "c1",
  channel_name: "general",
  group_id: "g1",
  thread_id: null,
  ...over,
}) as SearchMessageHit;

beforeEach(() => mockPush.mockClear());

test("a channel hit opens the channel landing on the matched message", () => {
  openHit(hit({}));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/(app)/channel/[id]",
    params: { id: "c1", name: "general", groupId: "g1", messageId: "77" },
  });
});

test("a thread reply hit opens its thread landing on the reply", () => {
  openHit(hit({ thread_id: 12 }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId: "c1", rootId: "12", channelName: "general", messageId: "77" },
  });
});
