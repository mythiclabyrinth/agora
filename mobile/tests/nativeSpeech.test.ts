jest.mock(
  "expo-speech",
  () => ({
    speak: jest.fn(),
    stop: jest.fn(async () => {}),
    isSpeakingAsync: jest.fn(async () => true),
  }),
  { virtual: true },
);
jest.mock("../src/lib/speech", () => ({
  stopSpeech: jest.fn(),
}));

import { AppState } from "react-native";
import { speakMessage, stopNativeSpeech, useNativeSpeech } from "../src/lib/nativeSpeech";

const native = jest.requireMock("expo-speech") as {
  speak: jest.Mock;
  stop: jest.Mock;
  isSpeakingAsync: jest.Mock;
};
const server = jest.requireMock("../src/lib/speech") as {
  stopSpeech: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

// Every Speak starts a reconcile poll; never leak one into the next test.
afterEach(() => stopNativeSpeech());

test("speaks the complete stored message after stopping existing audio", async () => {
  const text = "# Full answer\n\nEvery word, **including** markdown.";

  await expect(speakMessage({ text })).resolves.toBe(true);

  expect(server.stopSpeech).toHaveBeenCalledTimes(1);
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(native.speak).toHaveBeenCalledWith(
    text,
    expect.objectContaining({ useApplicationAudioSession: false }),
  );
  expect(native.stop.mock.invocationCallOrder[0]).toBeLessThan(
    native.speak.mock.invocationCallOrder[0],
  );
});

test("does nothing for a message without spoken text", async () => {
  await expect(speakMessage({ text: " \n\t " })).resolves.toBe(false);

  expect(server.stopSpeech).not.toHaveBeenCalled();
  expect(native.stop).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test("passes native synthesis errors to the caller", async () => {
  const onError = jest.fn();
  await speakMessage({ text: "Hello" }, onError);

  const options = native.speak.mock.calls[0][1];
  const error = new Error("synthesis failed");
  options.onError(error);
  expect(onError).toHaveBeenCalledWith(error);
});

describe("speaking state for the Stop banner", () => {
  beforeEach(() => useNativeSpeech.setState({ speaking: false }));

  test("is set while speaking and cleared when the utterance ends", async () => {
    await speakMessage({ text: "Hello" });
    expect(useNativeSpeech.getState().speaking).toBe(true);
    native.speak.mock.calls[0][1].onDone();
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("clears on a synthesis error", async () => {
    await speakMessage({ text: "Hello" });
    native.speak.mock.calls[0][1].onError(new Error("nope"));
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("a replaced utterance's late callbacks keep the new one's banner", async () => {
    await speakMessage({ text: "first" });
    await speakMessage({ text: "second" });
    const [first, second] = native.speak.mock.calls.map((call) => call[1]);
    first.onStopped();
    first.onDone();
    expect(useNativeSpeech.getState().speaking).toBe(true);
    second.onDone();
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("Stop halts the synthesizer and hides the banner at once", async () => {
    await speakMessage({ text: "Hello" });
    native.stop.mockClear();
    stopNativeSpeech();
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("a failed start clears the banner instead of leaving it stuck", async () => {
    native.stop.mockRejectedValueOnce(new Error("audio session busy"));
    await expect(speakMessage({ text: "Hello" })).rejects.toThrow("audio session busy");
    expect(useNativeSpeech.getState().speaking).toBe(false);

    native.speak.mockImplementationOnce(() => { throw new Error("no voice"); });
    await expect(speakMessage({ text: "Hello" })).rejects.toThrow("no voice");
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("Stop pressed before synthesis starts never starts it", async () => {
    let release!: () => void;
    native.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = speakMessage({ text: "Hello" });
    stopNativeSpeech();
    release();
    await pending;
    expect(native.speak).not.toHaveBeenCalled();
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });
});

describe("reconciling a strip whose callbacks never arrive", () => {
  let appStateListener: ((state: string) => void) | null;
  let removeAppState: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    useNativeSpeech.setState({ speaking: false });
    native.isSpeakingAsync.mockResolvedValue(true);
    appStateListener = null;
    removeAppState = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: removeAppState } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });
  afterEach(() => {
    stopNativeSpeech();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("clears the strip once the synthesizer reports it isn't speaking", async () => {
    await speakMessage({ text: "Hello" });
    native.isSpeakingAsync.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(2_500);
    expect(native.isSpeakingAsync).toHaveBeenCalled();
    expect(useNativeSpeech.getState().speaking).toBe(false);
    expect(removeAppState).toHaveBeenCalled(); // the watch is torn down
  });

  test("keeps the strip while the synthesizer is still talking", async () => {
    await speakMessage({ text: "Hello" });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(native.isSpeakingAsync).toHaveBeenCalled();
    expect(useNativeSpeech.getState().speaking).toBe(true);
  });

  test("never clears during the start-up grace period", async () => {
    await speakMessage({ text: "Hello" });
    native.isSpeakingAsync.mockResolvedValue(false);
    appStateListener?.("active");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(native.isSpeakingAsync).not.toHaveBeenCalled();
    expect(useNativeSpeech.getState().speaking).toBe(true);
  });

  test("re-checks when the app comes back to the foreground", async () => {
    await speakMessage({ text: "Hello" });
    await jest.advanceTimersByTimeAsync(2_000); // past the grace, before a poll
    native.isSpeakingAsync.mockResolvedValue(false);
    appStateListener?.("active");
    await jest.advanceTimersByTimeAsync(0);
    expect(useNativeSpeech.getState().speaking).toBe(false);
  });

  test("an older utterance's late check can't clear a newer one", async () => {
    await speakMessage({ text: "first" });
    let answer!: (talking: boolean) => void;
    native.isSpeakingAsync.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    await jest.advanceTimersByTimeAsync(2_500); // check for "first" now in flight
    await speakMessage({ text: "second" });
    answer(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(useNativeSpeech.getState().speaking).toBe(true);
  });

  test("Stop ends the poll", async () => {
    await speakMessage({ text: "Hello" });
    stopNativeSpeech();
    native.isSpeakingAsync.mockClear();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(native.isSpeakingAsync).not.toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalled();
  });
});
