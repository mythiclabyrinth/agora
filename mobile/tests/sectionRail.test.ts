import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AppState, StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentRailColors, ApiClient, ApiProvider, keys, type AgentInfo, type Message } from "@agora/core";
import {
  createSectionJumpController,
  MAX_VISIBLE_SECTION_DOTS,
  SECTION_JUMP_PASSES_MS,
  SECTION_JUMP_PASS_TIMEOUT_MS,
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
  constructor(private readonly agents: AgentInfo[]) {
    super({ baseUrl: "https://agora.example", token: "test" });
  }
  override async get<T>(path: string): Promise<T> {
    if (path === "/api/agents") return { agents: this.agents } as T;
    throw new Error(`Unexpected API request: ${path}`);
  }
}

const trees: TestRenderer.ReactTestRenderer[] = [];
const queryClients: QueryClient[] = [];
afterEach(() => {
  act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  for (const client of queryClients.splice(0)) client.clear();
});

function render(messages: Message[], activeMessageId: number | null, onJump = jest.fn(), agents: AgentInfo[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  queryClient.setQueryData(keys.agents, agents);
  const api = new FixtureApi(agents);
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
  trees.push(tree);
  queryClients.push(queryClient);
  return { tree, onJump };
}

const dots = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    (node) => typeof node.type === "string" && node.props?.accessibilityRole === "button",
    { deep: true },
  );

describe("SectionRail", () => {
  it("shows a marked agent as an outlined ring and fills it when selected", () => {
    const agents = [{ id: "helper", rail_marker: true }] as AgentInfo[];
    const color = agentRailColors(agents).get("helper");
    const messages = [message(1, "user"), message(2, "agent"), message(3, "user")];
    const dotStyle = (tree: TestRenderer.ReactTestRenderer) => {
      const agentDot = dots(tree)[1];
      expect(agentDot.props.accessibilityLabel).toMatch(/\(agent\)$/);
      return StyleSheet.flatten(agentDot.findAll(node => {
        const width = StyleSheet.flatten(node.props?.style)?.width;
        return width === 7 || width === 9;
      }, { deep: true })[0].props.style);
    };
    expect(dotStyle(render(messages, 1, jest.fn(), agents).tree)).toMatchObject({
      backgroundColor: "transparent", borderColor: color, borderWidth: 1.5,
    });
    expect(dotStyle(render(messages, 2, jest.fn(), agents).tree)).toMatchObject({
      backgroundColor: color, width: 9,
    });
  });
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

describe("createSectionJumpController with a list that reports completion", () => {
  const originalAppState = AppState.currentState;
  beforeEach(() => {
    jest.useFakeTimers();
    AppState.currentState = "active";
  });
  afterEach(() => {
    jest.useRealTimers();
    AppState.currentState = originalAppState;
  });

  it("waits for each scroll to settle before the next pass, then reports settled", async () => {
    const resolvers: (() => void)[] = [];
    const scrollToIndex = jest.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1), row(2)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(2, { animated: false, viewPosition: 0.5, onSettled });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    // A busy JS thread: the first scroll hasn't finished when its timer would fire.
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(true);
    await act(async () => { resolvers[0](); });
    jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[0]);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    await act(async () => { resolvers[1](); });
    jest.advanceTimersByTime(SECTION_JUMP_PASSES_MS[1] - SECTION_JUMP_PASSES_MS[0]);
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: false, viewPosition: 0.5 });
    await act(async () => { resolvers[2](); });
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS - SECTION_JUMP_PASSES_MS[1]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
  });

  it("never reports a cancelled jump as settled", async () => {
    let finish!: () => void;
    const scrollToIndex = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    controller.cancel();
    await act(async () => { finish(); });
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("finishes the jump at the pass timeout when a scroll never settles", () => {
    const scrollToIndex = jest.fn(() => new Promise<void>(() => {}));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS - 1);
    expect(controller.isJumping()).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
    // The list is broken: no further passes, the jump is over (~8s worst case).
    jest.advanceTimersByTime(1);
    expect(controller.isJumping()).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("finishes at the pass timeout when a correction pass's scroll never settles", async () => {
    let finishFirst!: () => void;
    const scrollToIndex = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(() => new Promise<void>(() => {}));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    await act(async () => { finishFirst(); });
    const [first] = SECTION_JUMP_PASSES_MS;
    jest.advanceTimersByTime(first);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("doesn't cut off a slow jump whose scrolls each settle within the pass timeout", async () => {
    const resolvers: (() => void)[] = [];
    const scrollToIndex = jest.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1), row(2)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(2, { onSettled });
    // A far landing still rendering on a low-end device: seconds per scroll.
    const slow = 5000;
    expect(slow).toBeLessThan(SECTION_JUMP_PASS_TIMEOUT_MS);
    const [first, second] = SECTION_JUMP_PASSES_MS;
    jest.advanceTimersByTime(slow);
    // Still waiting on the first scroll: no overlapping correction pass.
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0](); });
    jest.advanceTimersByTime(first + slow);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    await act(async () => { resolvers[1](); });
    jest.advanceTimersByTime(second - first);
    // Well past any single wall-clock cap on the whole jump: the final,
    // pinning pass still runs.
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: false, viewPosition: 0.08 });
    expect(controller.isJumping()).toBe(true);
    jest.advanceTimersByTime(slow);
    await act(async () => { resolvers[2](); });
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS - second);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
  });

  it("doesn't finish a jump at the pass timeout while the app is backgrounded", () => {
    const scrollToIndex = jest.fn(() => new Promise<void>(() => {}));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    AppState.currentState = "background";
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS * 3);
    expect(controller.isJumping()).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
    // Back: the re-armed period runs out, and only then does it finish.
    AppState.currentState = "active";
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("still takes a scroll that settles while its pass timeout is re-armed", async () => {
    let finish!: () => void;
    const scrollToIndex = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockImplementation(() => undefined);
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    AppState.currentState = "background";
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS * 2);
    AppState.currentState = "active";
    await act(async () => { finish(); });
    // The correction passes run as usual; the stale timeout never fires.
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS);
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("ignores a scroll that settles after its pass timed out", async () => {
    const resolvers: (() => void)[] = [];
    const scrollToIndex = jest.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // The scroll reports in late: no passes restart, nothing settles again.
    await act(async () => { resolvers[0](); });
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
  });

  it("doesn't wait out the pass timeout when there's no list to scroll", () => {
    // Unmounted mid-jump: nothing would ever settle.
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => null,
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
  });

  it("doesn't wait out the pass timeout for a scroll that returns no promise", () => {
    const scrollToIndex = jest.fn(() => undefined);
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    jest.advanceTimersByTime(SECTION_JUMP_SETTLE_MS);
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("a new jump's pass timeout survives the previous jump's late scroll", async () => {
    let finishFirst!: () => void;
    const scrollToIndex = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockImplementation(() => new Promise<void>(() => {}));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1), row(2)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1);
    controller.jumpTo(2, { onSettled });
    // The first jump's scroll settles late; the second still hangs.
    await act(async () => { finishFirst(); });
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS - 1);
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
    jest.runAllTimers();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("never reports a cancelled jump as settled, even past the pass timeouts", () => {
    const scrollToIndex = jest.fn(() => new Promise<void>(() => {}));
    const onSettled = jest.fn();
    const controller = createSectionJumpController({
      getRows: () => [row(1)],
      getList: () => ({ scrollToIndex }),
      onJumpStart: jest.fn(),
    });
    controller.jumpTo(1, { onSettled });
    controller.cancel();
    jest.advanceTimersByTime(SECTION_JUMP_PASS_TIMEOUT_MS * 10);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(controller.isJumping()).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
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
      trees.push(TestRenderer.create(React.createElement(Harness)));
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
