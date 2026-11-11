/* Pin how the signed-in shell wires the Speak Stop strip into every screen:
   the Stack's screenLayout wraps each screen in SpeakingScreen, and every
   headerless route is declared up front so the strip is placed right from
   the first frame. */

import fs from "fs";
import path from "path";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

type ScreenLayout = (props: { children: React.ReactElement; options: { headerShown?: boolean } }) =>
  React.ReactElement<{ headerShown: boolean; children: React.ReactNode }>;
let mockScreenLayout: ScreenLayout | undefined;

jest.mock("expo-router", () => {
  const { createElement, Fragment } = jest.requireActual("react");
  function MockStack({ screenLayout, children }: { screenLayout?: ScreenLayout; children?: unknown }) {
    mockScreenLayout = screenLayout;
    return createElement(Fragment, null, children);
  }
  MockStack.Screen = function MockStackScreen() { return null; };
  return { Redirect: () => null, Stack: MockStack, router: { push: jest.fn(), setParams: jest.fn() }, usePathname: () => "/" };
});
jest.mock("../src/components/SpeakingBanner", () => ({
  SpeakingScreen: function MockSpeakingScreen({ children }: { children: unknown }) { return children; },
}));
jest.mock("../src/state/session", () => {
  const state = { status: "signedIn", session: { baseUrl: "https://agora.test", token: "t" } };
  return {
    useSession: Object.assign(
      (select: (s: typeof state) => unknown) => select(state),
      { getState: () => ({ rememberDraftIdentity: jest.fn() }) },
    ),
  };
});
jest.mock("../src/ws/useAgoraSocket", () => ({ useAgoraSocket: jest.fn() }));
jest.mock("../src/lib/notifications", () => ({
  notifyAgentMessage: jest.fn(), reconcileNotifications: jest.fn(), setBadge: jest.fn(),
  registerPushToken: jest.fn(async () => true), setupNotifications: jest.fn(async () => {}),
}));
jest.mock("../src/lib/background", () => ({
  registerBackgroundPolling: jest.fn(async () => {}), saveUnreadSnapshot: jest.fn(),
  unregisterBackgroundPolling: jest.fn(async () => {}),
}));
jest.mock("../src/lib/notificationRegistration", () => ({
  readActionRegistration: jest.fn(), currentStoredSession: jest.fn(),
}));
jest.mock("../src/components/StoreReviewHost", () => ({ StoreReviewHost: () => null }));
jest.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "default",
  getLastNotificationResponse: () => null,
  addNotificationResponseReceivedListener: () => ({ remove: () => {} }),
  addNotificationResponseClearedListener: () => ({ remove: () => {} }),
  dismissNotificationAsync: jest.fn(async () => {}),
}));
jest.mock("@agora/core", () => ({
  ...jest.requireActual("@agora/core"),
  ApiProvider: ({ children }: { children: unknown }) => children,
  DraftSyncGate: () => null,
  draftSync: { flushAll: jest.fn() },
  useMe: () => ({ data: undefined }),
  useGroups: () => ({ data: undefined }),
  useThreads: () => ({ data: undefined }),
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import { Stack } from "expo-router";
import AppLayout from "../app/(app)/_layout";
import { SpeakingScreen } from "../src/components/SpeakingBanner";

const APP_DIR = path.join(__dirname, "..", "app", "(app)");

function renderLayout() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(AppLayout)); });
  return tree;
}

function headerlessDeclared(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Stack.Screen)
    .filter((node) => node.props.options?.headerShown === false)
    .map((node) => node.props.name as string)
    .sort();
}

/** Every route file under app/(app) that hides its header itself. */
function headerlessRouteFiles(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && entry.name !== "_layout.tsx"
        && /headerShown:\s*false/.test(fs.readFileSync(full, "utf8"))) {
        routes.push(path.relative(APP_DIR, full).replace(/\\/g, "/").replace(/\.tsx$/, ""));
      }
    }
  };
  walk(APP_DIR);
  return routes.sort();
}

test("every screen is wrapped in SpeakingScreen, headed unless it opts out", () => {
  mockScreenLayout = undefined;
  renderLayout();
  expect(mockScreenLayout).toEqual(expect.any(Function));
  const child = React.createElement("screen");

  const headed = mockScreenLayout!({ children: child, options: {} });
  expect(headed.type).toBe(SpeakingScreen);
  expect(headed.props).toEqual(expect.objectContaining({ headerShown: true, children: child }));

  const headerless = mockScreenLayout!({ children: child, options: { headerShown: false } });
  expect(headerless.type).toBe(SpeakingScreen);
  expect(headerless.props.headerShown).toBe(false);
});

test("the headerless routes are declared in the layout", () => {
  expect(headerlessDeclared(renderLayout())).toEqual(["index", "live/[channelId]"]);
});

test("every route that hides its header is declared headerless in the layout", () => {
  const files = headerlessRouteFiles();
  expect(files.length).toBeGreaterThan(0);
  expect(headerlessDeclared(renderLayout())).toEqual(files);
});
