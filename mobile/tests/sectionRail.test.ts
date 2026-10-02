import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, keys, type Message } from "@agora/core";
import {
  createSectionJumpController,
  MAX_VISIBLE_SECTION_DOTS,
  SECTION_JUMP_PASSES_MS,
  SECTION_JUMP_SETTLE_MS,
  SectionRail,
  useSectionJump,
} from "../src/components/SectionRail";

const message = (id: number, authorType: "user" | "agent"): Message => ({
  id,
  channel_id: "general",
  thread_id: null,
  author_type: authorType,
  author_id: authorType === "user" ? "alice" : "helper",
  author_name: authorType === "user" ? "Alice" : "Helper",
  text: `Message ${id}`,
  ts: 1,
  attachments: [],
});

class FixtureApi extends ApiClient {
  override async get<T>(path: string): Promise<T> {
    if (path === "/api/agents") return { agents: [] } as T;
    throw new Error(`Unexpected API request: ${path}`);
  }
}

function render(messages: Message[], activeMessageId: number | null, onJump = jest.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  queryClient.setQueryData(keys.agents, []);
  const api = new FixtureApi({ baseUrl: "https://agora.example", token: "test" });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(ApiProvider, { client: api },
          React.createElement(SectionRail, { messages, activeMessageId, onJump }),
        ),
      ),
    );
  });
  return { tree, onJump };
}

const dots = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    (node) => typeof node.type === "string" && node.props?.accessibilityRole === "button",
    { deep: true },
  );

describe("SectionRail", () => {
  it("hides below two sections", () => {
    expect(render([message(1, "user"), message(2, "agent")], 1).tree.toJSON()).toBeNull();
  });

  it("selects and jumps to the active conversational section", () => {
    const onJump = jest.fn();
    const { tree } = render(
      [message(1, "user"), message(2, "agent"), message(3, "user")],
      3,
      onJump,
    );
    const renderedDots = dots(tree);
    expect(renderedDots.map((dot) => dot.props.accessibilityState.selected)).toEqual([false, true]);
    const pressables = tree.root.findAll(
      (node) => node.props?.accessibilityRole === "button" && typeof node.props?.onPress === "function",
      { deep: true },
    );
    act(() => pressables[0].props.onPress());
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("caps overflow and keeps the active dot visible", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(index + 1, index % 2 === 0 ? "user" : "agent"),
    );
    for (const active of [1, 21, 39]) {
      const renderedDots = dots(render(messages, active).tree);
      expect(renderedDots).toHaveLength(MAX_VISIBLE_SECTION_DOTS);
      expect(renderedDots.filter((dot) => dot.props.accessibilityState.selected)).toHaveLength(1);
    }
  });

  it("uses absolute overlay geometry without consuming message width", () => {
    const { tree } = render([message(1, "user"), message(2, "user")], 1);
    const rail = tree.root.findAll(
      (node) => typeof node.type !== "string" && node.props?.pointerEvents === "box-none",
      { deep: true },
    )[0];
    const style = Object.assign({}, ...([] as object[]).concat(rail.props.style));
    expect(style).toMatchObject({ position: "absolute", right: 2, width: 20 });
    expect(style).not.toHaveProperty("left");
  });
});

const row = (id: number) => ({ kind: "msg", m: message(id, "agent") });

describe("createSectionJumpController", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(rows: unknown[]) {
    const scrollToIndex = jest.fn();
    const onJumpStart = jest.fn();
    const state = { rows };
    const controller = createSectionJumpController({
      getRows: () => state.rows,
      getList: () => ({ scrollToIndex }),
      onJumpStart,
    });
    return { controller, scrollToIndex, onJumpStart, state };
  }

  it("jumps immediately, reports the target, and stays in flight until settle", () => {
    const { controller, scrollToIndex, onJumpStart } = setup([row(1), row(2), row(3)]);
    controller.jumpTo(2);
    expect(onJumpStart).toHaveBeenCalledWith(2);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.08 });
    expect(controller.isJumping()).toBe(true);
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS);
    expect(controller.isJumping()).toBe(false);
  });

  it("re-resolves the index by id on each correction pass, ending non-animated", () => {
    const { controller, scrollToIndex, state } = setup([row(5), row(6), row(7)]);
    controller.jumpTo(6);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: true, viewPosition: 0.08 });
    // An older page prepends mid-animation: indices shift under the jump.
    state.rows = [row(1), row(2), row(3), row(4), row(5), row(6), row(7)];
    jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[0]);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 5, animated: true, viewPosition: 0.08 });
    jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[1] - SECTION_JUMP_PASSES_MS[0]);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 5, animated: false, viewPosition: 0.08 });
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
  });

  it("cancel stops corrections and ends the flight so tracking resumes", () => {
    const { controller, scrollToIndex } = setup([row(1), row(2)]);
    controller.jumpTo(1);
    controller.cancel();
    expect(controller.isJumping()).toBe(false);
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("skips passes while the target row is missing, then lands once loaded", () => {
    const { controller, scrollToIndex, state } = setup([row(2), row(3)]);
    controller.jumpTo(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
    state.rows = [row(1), row(2), row(3)];
    jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[0]);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: true, viewPosition: 0.08 });
  });
});

describe("useSectionJump", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setupHook() {
    const scrollToIndex = jest.fn();
    const listRef = { current: { scrollToIndex } };
    const atBottom = { current: true };
    const rows = [row(1), row(2), row(9)];
    let hook!: ReturnType<typeof useSectionJump>;
    function Harness() {
      hook = useSectionJump({ listRef, rows, atBottom, latestId: 9 });
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(Harness));
    });
    return { get hook() { return hook; }, scrollToIndex, atBottom };
  }

  it("selects the target optimistically and resumes viewability tracking after settling", () => {
    const harness = setupHook();

    act(() => harness.hook.jumpToSection(2));
    expect(harness.hook.activeMessageId).toBe(2);
    expect(harness.atBottom.current).toBe(false);
    expect(harness.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: true, viewPosition: 0.08 });

    // The transient viewport during the animation must not move the selection.
    const token = { index: 2, isViewable: true, item: row(9) };
    act(() => harness.hook.onViewableItemsChanged({ viewableItems: [token] }));
    expect(harness.hook.activeMessageId).toBe(2);

    // The jump settles without a user drag; live tracking resumes.
    act(() => jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS));
    act(() => harness.hook.onViewableItemsChanged({ viewableItems: [token] }));
    expect(harness.hook.activeMessageId).toBe(9);
  });

  it("resumes viewability tracking when a user drag cancels the jump", () => {
    const harness = setupHook();
    const token = { index: 2, isViewable: true, item: row(9) };

    act(() => harness.hook.jumpToSection(2));
    act(() => harness.hook.onViewableItemsChanged({ viewableItems: [token] }));
    expect(harness.hook.activeMessageId).toBe(2);

    act(() => harness.hook.cancelSectionJump());
    act(() => harness.hook.onViewableItemsChanged({ viewableItems: [token] }));
    expect(harness.hook.activeMessageId).toBe(9);
  });
});
