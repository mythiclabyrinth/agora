/* The gesture regression these guard: on the iOS new architecture a parent
   Pressable steals the pan from a nested horizontal ScrollView
   (facebook/react-native#56879), so a bubble-wrapping Pressable made wide
   markdown tables unscrollable. MessageItem must keep the table's ScrollView
   free of Pressable ancestors while long-press-to-star stays reachable via
   the text blocks and the backdrop. */

// Ships untranspiled ESM; the icons are irrelevant to what these tests assert.
jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ScrollView, StyleSheet, Text } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageItem } from "../src/components/MessageItem";
import { useSession } from "../src/state/session";
import { ApiClient, ApiProvider } from "@agora/core";
import type { Message } from "@agora/core";
import type { Session } from "@agora/core";

const session: Session = { baseUrl: "http://test", token: "t" };

const TABLE =
  "intro text\n\n| Date | Item | Amount |\n|---|---|---|\n| 25 Jun | TST*ULA, San Francisco | USD 198.22 |";

function message(text: string): Message {
  return {
    id: 1,
    channel_id: "c1",
    thread_id: null,
    author_type: "user",
    author_id: "alice",
    author_name: "Alice",
    text,
    ts: 1_700_000_000,
    attachments: [],
  };
}

const initialSessionState = useSession.getState();

beforeEach(() => {
  act(() => useSession.setState({ status: "signedIn", session }));
});

afterEach(() => {
  act(() => useSession.setState(initialSessionState, true));
});

function render(
  m: Message,
  onLongPress?: (msg: Message) => void,
  onOpenThread?: (msg: Message) => void,
) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        // useSelectOption/useUpdateFormState (rendered by every MessageItem)
        // read the client from @agora/core's ApiProvider.
        React.createElement(
          ApiProvider,
          { client: new ApiClient(session) },
          React.createElement(MessageItem, {
            session,
            message: m,
            onLongPress,
            onOpenThread,
          }),
        ),
      ),
    );
  });
  return tree;
}

/* A Pressable renders as a host View wired with responder handlers; that's
   what steals the pan from the nested ScrollView, so that's what we assert
   against (the Pressable component itself is a memo/forwardRef wrapper that
   react-test-renderer doesn't expose as an instance). */
function claimsResponder(node: TestRenderer.ReactTestInstance): boolean {
  return typeof node.props?.onStartShouldSetResponder === "function";
}

function isBackdrop(node: TestRenderer.ReactTestInstance): boolean {
  return node.props?.style === StyleSheet.absoluteFill && claimsResponder(node);
}

test("the table's ScrollView has no pressable ancestor", () => {
  const tree = render(message(TABLE), () => {});
  const scroll = tree.root.findAllByType(ScrollView)[0];
  for (let node = scroll.parent; node; node = node.parent) {
    expect(claimsResponder(node)).toBe(false);
  }
});

test("long-press still reaches the handler from the text, and the backdrop exists", () => {
  const onLongPress = jest.fn();
  const m = message(TABLE);
  const tree = render(m, onLongPress);

  // Paragraph text carries the long-press directly…
  const texts = tree.root.findAll(
    (n: TestRenderer.ReactTestInstance) =>
      String(n.type) === "Text" && typeof n.props.onLongPress === "function",
  );
  expect(texts.length).toBeGreaterThan(0);
  texts[0].props.onLongPress();
  expect(onLongPress).toHaveBeenCalledWith(m);

  // …and the bubble keeps a backdrop Pressable for padding/gap presses.
  expect(tree.root.findAll(isBackdrop).length).toBeGreaterThan(0);
});

test("without an onLongPress handler no backdrop Pressable is rendered", () => {
  const tree = render(message(TABLE));
  expect(tree.root.findAll(isBackdrop)).toHaveLength(0);
});

test("tap opens the thread while long-press opens only message options", () => {
  const onOpenThread = jest.fn();
  const onLongPress = jest.fn();
  const m = message("Tap or hold me");
  const tree = render(m, onLongPress, onOpenThread);
  const paragraph = tree.root.find((node) =>
    node.type === Text && node.props.selectable && typeof node.props.onPress === "function"
  );

  act(() => paragraph.props.onPress());
  expect(onOpenThread).toHaveBeenCalledWith(m);
  onOpenThread.mockClear();

  act(() => paragraph.props.onLongPress());
  act(() => paragraph.props.onPress());
  expect(onLongPress).toHaveBeenCalledWith(m);
  expect(onOpenThread).not.toHaveBeenCalled();
});

test("tapping a nested link does not open the thread", () => {
  const onOpenThread = jest.fn();
  const tree = render(message("Visit [Agora](https://example.com)"), undefined, onOpenThread);
  const link = tree.root.find((node) => node.type === Text && node.props.style?.textDecorationLine === "underline");
  const stopPropagation = jest.fn();
  act(() => link.props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalled();
  expect(onOpenThread).not.toHaveBeenCalled();
});

test("tapping a reaction does not open the thread", () => {
  const onOpenThread = jest.fn();
  const reacted = message("React independently");
  reacted.reactions = [{ emoji: "👍", users: ["bob"] }];
  const tree = render(reacted, undefined, onOpenThread);
  const reaction = tree.root.find((node) =>
    node.props.accessibilityLabel === "bob reacted with 👍"
  );
  act(() => reaction.props.onPress());
  expect(onOpenThread).not.toHaveBeenCalled();
});

test.each([
  ["current-user", "alice"],
  ["other-user", "bob"],
])("renders artifacts in the %s message branch", (_label, username) => {
  act(() => useSession.setState({ username }));
  const m = message("An artifact follows");
  m.meta = {
    artifacts: [
      {
        id: "future",
        type: "timeline",
        version: 99,
        title: "Future artifact",
        data: {},
      },
    ],
  };
  const tree = render(m);
  const text = tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .flat()
    .join(" ");
  expect(text).toContain("Future artifact");
  expect(text).toContain("cannot display");
});

test("renders a supported map artifact from message metadata", () => {
  const m = message("A map follows");
  m.meta = {
    artifacts: [
      {
        id: "map",
        type: "map",
        version: 1,
        title: "Test itinerary",
        data: {
          initial_view: { mode: "fit" },
          regions: [
            {
              id: "r",
              label: "Region",
              center: { lat: 1, lng: 2 },
              day_ids: [],
            },
          ],
          days: [],
          places: [],
          routes: [],
        },
      },
    ],
  };
  const tree = render(m);
  const text = tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .flat()
    .join(" ");
  expect(text).toContain("Test itinerary");
  expect(
    tree.root.findAll((node) => node.props.testID === "coordinate-map").length,
  ).toBeGreaterThan(0);
});

test("shows an edited marker when edited_at is present", () => {
  const edited = message("Updated text");
  edited.meta = { edited_at: 1_700_000_100 };
  const tree = render(edited);
  expect(tree.root.findAllByType(Text).some((node) =>
    Array.isArray(node.props.children) && node.props.children.includes("edited · "),
  )).toBe(true);
});
