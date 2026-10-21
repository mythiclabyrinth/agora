/* The voice loop end to end, in node: the browser audio stack is faked
   (getUserMedia, AudioContext/AnalyserNode, MediaRecorder, Audio, object
   URLs) and the server calls are mocked. The fake analyser reports whatever
   `env.rms` is, so a test "speaks" by raising it and lets the loop's 50 ms
   tick run under fake timers (performance.now() included). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, JarvisCard, JarvisEvent } from "@agora/core";

const core = vi.hoisted(() => ({
  jarvisTranscribe: vi.fn(),
  jarvisTurn: vi.fn(),
  jarvisSpeech: vi.fn(),
  resetJarvisConversation: vi.fn(),
}));
const cards = vi.hoisted(() => ({ sendDraftEntry: vi.fn(), cancelDraftEntry: vi.fn() }));
const chime = vi.hoisted(() => ({ armChimeNow: vi.fn(), playChime: vi.fn() }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@agora/core", () => core);
vi.mock("../panel/JarvisCards", () => cards);
vi.mock("../../lib/chime", () => chime);
vi.mock("../../lib/toast", () => toasts);
vi.mock("../../lib/auth", () => ({ sessionToken: () => "tok" }));
vi.mock("../../lib/voice", () => ({ recMime: () => "audio/webm", voiceSupported: () => true }));
vi.mock("../../state/ui", () => ({
  useUiState: { getState: () => ({ view: { kind: "inbox" }, sel: {}, threadRoot: null }) },
}));
vi.mock("../../state/liveVoice", async () => {
  const { create } = await import("zustand");
  return { useLiveVoice: create(() => ({ scope: null as string | null })) };
});

// ------------------------------------------------------------ browser fakes

const env = { rms: 0, getUserMedia: vi.fn() };

class FakeTrack { stop = vi.fn(); }
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
}

class FakeAnalyser {
  fftSize = 2048;
  connect() {}
  getFloatTimeDomainData(buf: Float32Array) { buf.fill(env.rms); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  destination = {};
  constructor() { FakeAudioContext.instances.push(this); }
  resume() { return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
  createAnalyser() { return new FakeAnalyser(); }
  createMediaStreamSource() { return { connect() {} }; }
  createMediaElementSource() { return { connect() {}, disconnect() {} }; }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") throw new Error("not recording");
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.(new Event("stop"));
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  constructor() { FakeAudio.instances.push(this); }
  setAttribute() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  /** The clip played to its end. */
  end() { this.onended?.(); }
}

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: env.getUserMedia } });
vi.stubGlobal("AudioContext", FakeAudioContext);
vi.stubGlobal("MediaRecorder", FakeRecorder);
vi.stubGlobal("Audio", FakeAudio);
vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip");
vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

const { useJarvis } = await import("../../state/jarvis");
const voice = await import("./conversation");
const initial = useJarvis.getState();

const api = { delete: vi.fn() } as unknown as ApiClient;

// ------------------------------------------------------------ helpers

/** Let `ms` of loop time pass (ticks, timers, and the promises between). */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Open the loop and say something it will record and transcribe. */
async function speak(transcript: string | Error) {
  if (transcript instanceof Error) core.jarvisTranscribe.mockRejectedValueOnce(transcript);
  else core.jarvisTranscribe.mockResolvedValueOnce(transcript);
  if (voice.voiceDebugState().capture === "off") await voice.listen("open");
  env.rms = 0.05;
  await pass(500);
  env.rms = 0.001;
  await pass(900);
}

type OnEvent = (event: JarvisEvent) => void;

/** A turn that streams `deltas` and finishes. */
function answer(...deltas: string[]) {
  core.jarvisTurn.mockImplementationOnce(async (_s: unknown, _req: unknown, onEvent: OnEvent) => {
    onEvent({ type: "start", conversation_id: "jc1" } as JarvisEvent);
    for (const text of deltas) onEvent({ type: "delta", text } as JarvisEvent);
    onEvent({ type: "done", conversation_id: "jc1", text: deltas.join("") } as JarvisEvent);
  });
}

/** A turn that streams `deltas` and then hangs until aborted. */
function hangingAnswer(...deltas: string[]) {
  const seen: { signal: AbortSignal | null } = { signal: null };
  core.jarvisTurn.mockImplementationOnce((_s: unknown, _req: unknown, onEvent: OnEvent, signal: AbortSignal) => {
    seen.signal = signal;
    onEvent({ type: "start", conversation_id: "jc1" } as JarvisEvent);
    for (const text of deltas) onEvent({ type: "delta", text } as JarvisEvent);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  return seen;
}

function draft(id: string): { id: string; card: JarvisCard; status: "pending" } {
  return {
    id,
    status: "pending",
    card: {
      kind: "draft", draft_id: `d_${id}`, channel_id: "c1", channel_name: "release", group_id: "g1",
      group_name: "Eng", thread_id: null, destination: "#release", text: "rerun it", final_text: "rerun it",
      mentions: [], expires_in: 600,
    },
  };
}

const spokenTexts = () => core.jarvisSpeech.mock.calls.map(c => c[1] as string);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  storage.clear();
  useJarvis.setState(initial, true);
  vi.clearAllMocks();
  FakeRecorder.instances = [];
  FakeAudio.instances = [];
  env.rms = 0;
  env.getUserMedia.mockImplementation(async () => new FakeStream());
  core.jarvisSpeech.mockImplementation(async (_s: unknown, text: string) => new Blob([text]));
  core.resetJarvisConversation.mockResolvedValue({ ok: true });
  cards.sendDraftEntry.mockResolvedValue(true);
  voice.configureVoice({ api, stt: true, tts: true, open: true });
});

afterEach(() => {
  voice.closeVoice();
  vi.useRealTimers();
});

// ------------------------------------------------------------ tests

describe("spoken draft confirmation", () => {
  it("'send it' with exactly one pending draft sends it once and runs no model turn", async () => {
    const one = draft("a");
    useJarvis.setState({ cards: [one] });
    await speak("Send it.");
    expect(cards.sendDraftEntry).toHaveBeenCalledTimes(1);
    expect(cards.sendDraftEntry).toHaveBeenCalledWith(api, one, one.card);
    expect(cards.cancelDraftEntry).not.toHaveBeenCalled();
    expect(core.jarvisTurn).not.toHaveBeenCalled();
    expect(useJarvis.getState().log.map(e => [e.role, e.text])).toEqual([
      ["user", "Send it."], ["assistant", "Sent to #release."],
    ]);
    expect(spokenTexts()).toEqual(["Sent to #release."]);
  });

  it("'cancel' with one pending draft cancels it and runs no model turn", async () => {
    const one = draft("a");
    useJarvis.setState({ cards: [one] });
    await speak("cancel");
    expect(cards.cancelDraftEntry).toHaveBeenCalledTimes(1);
    expect(cards.cancelDraftEntry).toHaveBeenCalledWith(api, one, one.card);
    expect(cards.sendDraftEntry).not.toHaveBeenCalled();
    expect(core.jarvisTurn).not.toHaveBeenCalled();
    expect(useJarvis.getState().log.at(-1)?.text).toBe("Cancelled. Nothing was sent.");
  });

  it("a typed 'yes' to \"Send it?\" sends the draft too (no mic involved)", async () => {
    const one = draft("a");
    useJarvis.setState({ cards: [one] });
    useJarvis.getState().say("I’ve drafted this in #release: “Deploy at 5.” Send it?");
    await voice.handleUtterance("yes");
    expect(cards.sendDraftEntry).toHaveBeenCalledTimes(1);
    expect(core.jarvisTurn).not.toHaveBeenCalled();
  });

  it("a typed message with no pending draft is an ordinary turn", async () => {
    answer("What should the message to #release say?");
    await voice.handleUtterance("send a message to #release");
    expect(cards.sendDraftEntry).not.toHaveBeenCalled();
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
  });

  it("a bare 'yes' sends the draft only when it answers the read-back's \"Send it?\"", async () => {
    const one = draft("a");
    useJarvis.setState({ cards: [one] });
    useJarvis.getState().say("I’ve drafted this in #release: “@claude rerun it.” Send it?");
    await speak("Yes.");
    expect(cards.sendDraftEntry).toHaveBeenCalledTimes(1);
    expect(core.jarvisTurn).not.toHaveBeenCalled();
  });

  it("a bare 'yes' to some other question is an ordinary turn, even with a draft pending", async () => {
    useJarvis.setState({ cards: [draft("a")] });
    useJarvis.getState().say("Did you mean #release or #releases?");
    answer("Got it.");
    await speak("yes");
    expect(cards.sendDraftEntry).not.toHaveBeenCalled();
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no pending draft", [] as ReturnType<typeof draft>[]],
    ["two pending drafts", [draft("a"), draft("b")]],
  ])("with %s, 'send it' is an ordinary turn", async (_name, pending) => {
    useJarvis.setState({ cards: pending });
    answer("Which one?");
    await speak("send it");
    expect(cards.sendDraftEntry).not.toHaveBeenCalled();
    expect(cards.cancelDraftEntry).not.toHaveBeenCalled();
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
    expect(core.jarvisTurn.mock.calls[0][1]).toMatchObject({ text: "send it" });
  });
});

describe("turns and speech", () => {
  it("runs a turn for a spoken ask and queues the streamed answer for TTS sentence by sentence", async () => {
    answer("First sentence. Sec", "ond one! Third", " part");
    await speak("what happened with the deploy?");
    expect(core.jarvisTranscribe).toHaveBeenCalledTimes(1);
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
    expect(core.jarvisTurn.mock.calls[0][1]).toMatchObject({ text: "what happened with the deploy?", conversation_id: null });
    expect(spokenTexts()).toEqual(["First sentence.", "Second one!", "Third part"]);
    // Played in order, one clip at a time.
    expect(FakeAudio.instances).toHaveLength(1);
    expect(useJarvis.getState().phase).toBe("speaking");
    expect(useJarvis.getState().spoken).toMatchObject({ start: 0, end: "First sentence.".length });
    FakeAudio.instances[0].end();
    await pass(0);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(useJarvis.getState().spoken?.start).toBe("First sentence. ".length);
    expect(useJarvis.getState().conversationId).toBe("jc1");
  });

  it("barge-in during playback stops speech, aborts the running turn and starts recording", async () => {
    const turn = hangingAnswer("Here is a long answer. ", "And more of it. ");
    await speak("tell me everything");
    expect(useJarvis.getState().busy).toBe(true);
    expect(voice.voiceDebugState().speaking).toBe(true);
    const clip = FakeAudio.instances[0];
    const recordersBefore = FakeRecorder.instances.length;

    env.rms = 0.05; // the user talks over the answer
    await pass(250);

    expect(clip.paused).toBe(true);
    expect(turn.signal?.aborted).toBe(true);
    expect(useJarvis.getState().busy).toBe(false);
    expect(voice.voiceDebugState()).toMatchObject({ capture: "recording", speaking: false, queued: 0 });
    expect(FakeRecorder.instances.length).toBe(recordersBefore + 1);
    expect(useJarvis.getState().phase).toBe("recording");
    // Nothing more of the dropped answer is played.
    await pass(100);
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("listens for a follow-up once speech drains, then releases the mic after the window", async () => {
    answer("All good.");
    await speak("is the build green?");
    expect(useJarvis.getState().micOwned).toBe(true);
    chime.playChime.mockClear();

    FakeAudio.instances[0].end();
    await pass(0);
    expect(voice.voiceDebugState()).toMatchObject({ capture: "waiting", micOpen: true, speaking: false });
    expect(useJarvis.getState().phase).toBe("listening");
    expect(chime.playChime).not.toHaveBeenCalled(); // a follow-up doesn't chime

    await pass(voice.FOLLOW_UP_MS - 500);
    expect(useJarvis.getState().micOwned).toBe(true);
    await pass(1000);
    expect(useJarvis.getState().micOwned).toBe(false);
    expect(voice.voiceDebugState()).toMatchObject({ capture: "off", micOpen: false });
    expect(useJarvis.getState().phase).toBe("idle");
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("mic and speaker toggles", () => {
  it("a muted mic never captures", async () => {
    useJarvis.getState().setMicMuted(true);
    await voice.listen("open");
    expect(env.getUserMedia).not.toHaveBeenCalled();
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(voice.voiceDebugState().micOpen).toBe(false);
  });

  it("speaker off requests no TTS", async () => {
    useJarvis.getState().setSpeakerOff(true);
    answer("Quiet answer. Two sentences.");
    await voice.runTurn("hello");
    await pass(0);
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
    expect(core.jarvisSpeech).not.toHaveBeenCalled();
    expect(FakeAudio.instances).toHaveLength(0);
    expect(useJarvis.getState().log.at(-1)?.text).toBe("Quiet answer. Two sentences.");
  });
});

describe("listening edge cases", () => {
  it("a 'couldn't hear' transcription keeps listening without an error", async () => {
    await speak(new Error("Couldn't hear anything"));
    expect(core.jarvisTurn).not.toHaveBeenCalled();
    expect(useJarvis.getState().error).toBeNull();
    expect(useJarvis.getState().phase).toBe("listening");
    expect(voice.voiceDebugState()).toMatchObject({ capture: "waiting", micOpen: true });
  });

  it("other transcription failures are shown, and it still keeps listening", async () => {
    await speak(new Error("Speech-to-text is down"));
    expect(useJarvis.getState().error).toBe("Speech-to-text is down");
    expect(voice.voiceDebugState().capture).toBe("waiting");
  });

  it("a wake while a turn is running gives no chime and starts no capture, but holds the mic for barge-in", async () => {
    useJarvis.setState({ busy: true });
    await voice.listen("open");
    expect(chime.armChimeNow).not.toHaveBeenCalled();
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(voice.voiceDebugState().capture).toBe("off");
    expect(useJarvis.getState().phase).not.toBe("listening");
    expect(useJarvis.getState().micOwned).toBe(true);
  });
});

describe("newConversation", () => {
  it("tells the server to forget the conversation, then resets the session", async () => {
    useJarvis.setState({ conversationId: "jc9", cards: [draft("a")] });
    useJarvis.getState().say("earlier answer");
    voice.newConversation(api);
    expect(core.resetJarvisConversation).toHaveBeenCalledWith(api, "jc9");
    expect(useJarvis.getState()).toMatchObject({ conversationId: null, cards: [], log: [] });
  });

  it("ignores a failed reset and skips the call when there is no conversation", async () => {
    core.resetJarvisConversation.mockRejectedValueOnce(new Error("offline"));
    useJarvis.setState({ conversationId: "jc9" });
    voice.newConversation(api);
    await pass(0);
    expect(useJarvis.getState().conversationId).toBeNull();
    voice.newConversation(api);
    expect(core.resetJarvisConversation).toHaveBeenCalledTimes(1);
  });
});
