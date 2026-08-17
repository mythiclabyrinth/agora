const mockRead = jest.fn();
const mockWrite = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/",
  readAsStringAsync: (...args: unknown[]) => mockRead(...args),
  writeAsStringAsync: (...args: unknown[]) => mockWrite(...args),
}));

jest.mock("expo-application", () => ({
  nativeApplicationVersion: "1.2.3",
}));

const mockIsAvailable = jest.fn().mockResolvedValue(true);
const mockHasAction = jest.fn().mockResolvedValue(true);
const mockRequestReview = jest.fn().mockResolvedValue(undefined);
jest.mock("expo-store-review", () => ({
  isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
  hasAction: (...args: unknown[]) => mockHasAction(...args),
  requestReview: (...args: unknown[]) => mockRequestReview(...args),
}));

import type { Message } from "@agora/core";
import {
  agentReplyFollowsUser,
  canRequestReview,
  flushDeferredReviewPrompt,
  getStoreReviewRuntimeForTests,
  localDayKey,
  recordPositiveEvent,
  resetStoreReviewRuntimeForTests,
  setReviewVoiceActive,
  beginReviewUiBlock,
  endReviewUiBlock,
} from "../src/lib/storeReview";
import {
  resetReviewSessionLatchForTests,
  useReview,
} from "../src/state/review";

const DAY = 24 * 60 * 60 * 1000;

function msg(partial: Partial<Message> & Pick<Message, "id" | "author_type" | "author_id">): Message {
  return {
    channel_id: "general",
    thread_id: null,
    author_name: partial.author_id,
    text: "",
    ts: partial.id,
    attachments: [],
    ...partial,
  };
}

beforeEach(() => {
  mockRead.mockReset();
  mockWrite.mockClear();
  mockIsAvailable.mockReset().mockResolvedValue(true);
  mockHasAction.mockReset().mockResolvedValue(true);
  mockRequestReview.mockReset().mockResolvedValue(undefined);
  resetStoreReviewRuntimeForTests();
  resetReviewSessionLatchForTests();
  useReview.setState({
    loaded: false,
    firstLaunchAt: null,
    sessionCount: 0,
    positiveEvents: 0,
    lastPositiveEventDay: null,
    lastPromptedVersion: null,
    lastPromptedAt: null,
    promptCount: 0,
  });
});

describe("canRequestReview", () => {
  const ready = {
    loaded: true,
    firstLaunchAt: Date.now() - 4 * DAY,
    sessionCount: 3,
    positiveEvents: 2,
    lastPromptedVersion: null,
    lastPromptedAt: null,
    promptCount: 0,
  };

  it("passes when every gate is satisfied", () => {
    expect(canRequestReview(ready, { now: Date.now(), version: "1.0.0" })).toBe(true);
  });

  it("requires two positive events", () => {
    expect(
      canRequestReview({ ...ready, positiveEvents: 1 }, { now: Date.now(), version: "1.0.0" }),
    ).toBe(false);
  });

  it("requires three sessions", () => {
    expect(
      canRequestReview({ ...ready, sessionCount: 2 }, { now: Date.now(), version: "1.0.0" }),
    ).toBe(false);
  });

  it("requires three days since first launch", () => {
    const now = Date.now();
    expect(
      canRequestReview(
        { ...ready, firstLaunchAt: now - 2 * DAY },
        { now, version: "1.0.0" },
      ),
    ).toBe(false);
  });

  it("blocks the same app version", () => {
    expect(
      canRequestReview(
        { ...ready, lastPromptedVersion: "1.0.0" },
        { now: Date.now(), version: "1.0.0" },
      ),
    ).toBe(false);
  });

  it("requires ninety days since the previous attempt", () => {
    const now = Date.now();
    expect(
      canRequestReview(
        { ...ready, lastPromptedVersion: "0.9.0", lastPromptedAt: now - 89 * DAY },
        { now, version: "1.0.0" },
      ),
    ).toBe(false);
    expect(
      canRequestReview(
        { ...ready, lastPromptedVersion: "0.9.0", lastPromptedAt: now - 90 * DAY },
        { now, version: "1.0.0" },
      ),
    ).toBe(true);
  });

  it("hard-stops after two lifetime attempts", () => {
    expect(
      canRequestReview({ ...ready, promptCount: 2 }, { now: Date.now(), version: "1.0.0" }),
    ).toBe(false);
  });
});

describe("agentReplyFollowsUser", () => {
  it("counts when the prior human message is ours", () => {
    const messages = [
      msg({ id: 1, author_type: "user", author_id: "me" }),
      msg({ id: 2, author_type: "agent", author_id: "bot" }),
    ];
    expect(agentReplyFollowsUser(messages, messages[1], "me")).toBe(true);
  });

  it("ignores unprompted agent posts after someone else spoke", () => {
    const messages = [
      msg({ id: 1, author_type: "user", author_id: "me" }),
      msg({ id: 2, author_type: "user", author_id: "other" }),
      msg({ id: 3, author_type: "agent", author_id: "bot" }),
    ];
    expect(agentReplyFollowsUser(messages, messages[2], "me")).toBe(false);
  });

  it("allows agent chatter between our message and the reply", () => {
    const messages = [
      msg({ id: 1, author_type: "user", author_id: "me" }),
      msg({ id: 2, author_type: "agent", author_id: "other-bot" }),
      msg({ id: 3, author_type: "agent", author_id: "bot" }),
    ];
    expect(agentReplyFollowsUser(messages, messages[2], "me")).toBe(true);
  });
});

describe("localDayKey", () => {
  it("formats the local calendar date as YYYY-MM-DD", () => {
    const local = new Date(2024, 5, 15, 9, 30, 0); // Jun 15 2024 09:30 local
    expect(localDayKey(local.getTime())).toBe("2024-06-15");
  });

  it("rolls over on local midnight, not UTC", () => {
    // 11pm local on June 15 — west of UTC this is already June 16 in UTC.
    const lateLocal = new Date(2024, 5, 15, 23, 0, 0);
    expect(localDayKey(lateLocal.getTime())).toBe("2024-06-15");
    if (lateLocal.getTimezoneOffset() > 0) {
      expect(lateLocal.toISOString().slice(0, 10)).toBe("2024-06-16");
    }
  });
});

describe("review persistence and deferred flush", () => {
  it("bumps session count once per load and sets firstLaunchAt", async () => {
    mockRead.mockRejectedValue(new Error("missing"));
    await useReview.getState().load();
    const state = useReview.getState();
    expect(state.loaded).toBe(true);
    expect(state.sessionCount).toBe(1);
    expect(state.firstLaunchAt).toEqual(expect.any(Number));
    expect(mockWrite).toHaveBeenCalledWith(
      "file:///test/store-review.json",
      expect.stringContaining('"sessionCount":1'),
    );
  });

  it("does not double-count sessions when load runs twice in one process", async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({
        firstLaunchAt: 1000,
        sessionCount: 2,
        positiveEvents: 0,
        lastPositiveEventDay: null,
        lastPromptedVersion: null,
        lastPromptedAt: null,
        promptCount: 0,
      }),
    );
    await useReview.getState().load();
    expect(useReview.getState().sessionCount).toBe(3);
    mockRead.mockResolvedValue(
      JSON.stringify({
        firstLaunchAt: 1000,
        sessionCount: 3,
        positiveEvents: 0,
        lastPositiveEventDay: null,
        lastPromptedVersion: null,
        lastPromptedAt: null,
        promptCount: 0,
      }),
    );
    await useReview.getState().load();
    expect(useReview.getState().sessionCount).toBe(3);
  });

  it("queues a deferred prompt and flushes only when gates and UI allow it", async () => {
    const now = Date.now();
    useReview.setState({
      loaded: true,
      firstLaunchAt: now - 4 * DAY,
      sessionCount: 3,
      positiveEvents: 1,
      lastPositiveEventDay: "2000-01-01",
      lastPromptedVersion: null,
      lastPromptedAt: null,
      promptCount: 0,
    });

    await recordPositiveEvent(now);
    expect(useReview.getState().positiveEvents).toBe(2);
    expect(getStoreReviewRuntimeForTests().pendingPrompt).toBe(true);
    expect(mockRequestReview).not.toHaveBeenCalled();

    setReviewVoiceActive(true);
    expect(await flushDeferredReviewPrompt()).toBe(false);
    expect(mockRequestReview).not.toHaveBeenCalled();

    setReviewVoiceActive(false);
    beginReviewUiBlock();
    expect(await flushDeferredReviewPrompt()).toBe(false);
    endReviewUiBlock();

    expect(await flushDeferredReviewPrompt()).toBe(true);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(useReview.getState().promptCount).toBe(1);
    expect(useReview.getState().lastPromptedVersion).toBe("1.2.3");
    expect(getStoreReviewRuntimeForTests().pendingPrompt).toBe(false);

    // Same version must not prompt again even with a fresh pending flag.
    await recordPositiveEvent(now + DAY);
    expect(await flushDeferredReviewPrompt()).toBe(false);
  });

  it("ignores mutations until load finishes (load-before-read race)", async () => {
    useReview.setState({ loaded: false, positiveEvents: 0, lastPositiveEventDay: null });
    useReview.getState().incrementPositive("2024-06-15");
    expect(useReview.getState().positiveEvents).toBe(0);
  });

  it("caps positive events at one per local day", async () => {
    const day1 = new Date(2024, 5, 15, 10, 0, 0).getTime();
    const day1Later = new Date(2024, 5, 15, 22, 0, 0).getTime();
    const day2 = new Date(2024, 5, 16, 9, 0, 0).getTime();
    useReview.setState({
      loaded: true,
      firstLaunchAt: day1,
      sessionCount: 1,
      positiveEvents: 0,
      lastPositiveEventDay: null,
      lastPromptedVersion: null,
      lastPromptedAt: null,
      promptCount: 0,
    });

    await recordPositiveEvent(day1);
    expect(useReview.getState().positiveEvents).toBe(1);
    expect(useReview.getState().lastPositiveEventDay).toBe("2024-06-15");

    await recordPositiveEvent(day1Later);
    expect(useReview.getState().positiveEvents).toBe(1);
    expect(useReview.getState().lastPositiveEventDay).toBe("2024-06-15");

    await recordPositiveEvent(day2);
    expect(useReview.getState().positiveEvents).toBe(2);
    expect(useReview.getState().lastPositiveEventDay).toBe("2024-06-16");
  });

  it("still sets the pending flag when today's credit is already banked", async () => {
    const now = new Date(2024, 5, 15, 18, 0, 0).getTime();
    useReview.setState({
      loaded: true,
      firstLaunchAt: now,
      sessionCount: 1,
      positiveEvents: 1,
      lastPositiveEventDay: "2024-06-15",
      lastPromptedVersion: null,
      lastPromptedAt: null,
      promptCount: 0,
    });

    await recordPositiveEvent(now);
    expect(useReview.getState().positiveEvents).toBe(1);
    expect(getStoreReviewRuntimeForTests().pendingPrompt).toBe(true);
  });
});
