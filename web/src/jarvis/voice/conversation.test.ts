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
const cards = vi.hoisted(() => ({ announceSent: vi.fn(), saveDraftEdit: vi.fn() }));
const chime = vi.hoisted(() => ({ armChimeNow: vi.fn(), playChime: vi.fn() }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
const nav = vi.hoisted(() => ({ jumpTo: vi.fn() }));

vi.mock("@agora/core", () => core);
vi.mock("../panel/JarvisCards", () => cards);
vi.mock("../../lib/chime", () => chime);
vi.mock("../../lib/toast", () => toasts);
vi.mock("../navigate", () => nav);
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
  else core.jarvisTranscribe.mockResolvedValueOnce({ text: transcript, noSpeech: !transcript });
  if (voice.voiceDebugState().capture === "off") await voice.listen("open");
  env.rms = 0.05;
  await pass(500);
  env.rms = 0.001;
  await pass(voice.END_OF_SPEECH_MS + 100);
}

type OnEvent = (event: JarvisEvent) => void;

/** A turn that streams `deltas` and finishes. */
function answer(...deltas: string[]) {
  answerWith([], ...deltas);
}

/** A turn that streams `events` first (e.g. draft_sent), then `deltas`. */
function answerWith(events: JarvisEvent[], ...deltas: string[]) {
  core.jarvisTurn.mockImplementationOnce(async (_s: unknown, _req: unknown, onEvent: OnEvent) => {
    onEvent({ type: "start", conversation_id: "jc1" } as JarvisEvent);
    for (const e of events) onEvent(e);
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
      mentions: [], expires_in: 600, revision: 1,
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
  cards.saveDraftEdit.mockResolvedValue(true);
  voice.configureVoice({ api, stt: true, tts: true, open: true });
});

afterEach(() => {
  voice.closeVoice();
  vi.useRealTimers();
});

// ------------------------------------------------------------ tests

describe("replies to a draft", () => {
  it.each(["yes", "Send it.", "haan bhej do", "sí, envíalo", "only if Priya agrees", "cancel"])(
    "sends %j to the server as an ordinary turn, even with a draft pending", async (reply) => {
      useJarvis.setState({ cards: [draft("a")] });
      answer("Okay.");
      await speak(reply);
      expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
      expect(core.jarvisTurn.mock.calls[0][1]).toMatchObject({ text: reply });
      expect(useJarvis.getState().cards[0].status).toBe("pending"); // only the server's events change it
    },
  );

  it("applies draft_sent: the card is sent, Undo is offered, the acknowledgement is logged and spoken", async () => {
    const one = draft("a");
    useJarvis.setState({ cards: [one] });
    answerWith([
      { type: "draft_sent", draft_id: "d_a", message: { id: 42 } } as unknown as JarvisEvent,
    ], "Sent to #release.");
    await voice.handleUtterance("yes go ahead");
    const card = useJarvis.getState().cards[0];
    expect(card).toMatchObject({ status: "sent", messageId: 42 });
    expect(cards.announceSent).toHaveBeenCalledWith(api, "a", one.card, 42);
    expect(useJarvis.getState().log.map(e => [e.role, e.text])).toEqual([
      ["user", "yes go ahead"], ["assistant", "Sent to #release."],
    ]);
    expect(spokenTexts()).toEqual(["Sent to #release."]);
  });

  it("no second Undo toast when the card's Send already posted it", async () => {
    useJarvis.setState({ cards: [draft("a")] });
    answerWith([
      { type: "draft_sent", draft_id: "d_a", message: { id: 42 }, already_sent: true } as unknown as JarvisEvent,
    ], "Sent to #release.");
    await voice.handleUtterance("yes go ahead");
    expect(useJarvis.getState().cards[0]).toMatchObject({ status: "sent", messageId: 42 });
    expect(cards.announceSent).not.toHaveBeenCalled();
  });

  it("applies draft_cancelled for a spoken no and for a superseded draft", async () => {
    useJarvis.setState({ cards: [draft("b"), draft("a")] });
    answerWith([{ type: "draft_cancelled", draft_id: "d_a", superseded_by: null } as JarvisEvent], "Cancelled. Nothing was sent.");
    await voice.handleUtterance("no");
    expect(useJarvis.getState().cards.map(c => c.status)).toEqual(["pending", "cancelled"]);
    answerWith([{ type: "draft_cancelled", draft_id: "d_b", superseded_by: "d_c" } as JarvisEvent], "Changed it.");
    await voice.handleUtterance("change it to 5pm");
    expect(useJarvis.getState().cards.map(c => c.status)).toEqual(["cancelled", "cancelled"]);
    expect(cards.announceSent).not.toHaveBeenCalled();
  });

  it("saves card edits before the turn, so a yes is judged against what the card shows", async () => {
    const order: string[] = [];
    cards.saveDraftEdit.mockImplementation(async () => { order.push("save"); return true; });
    useJarvis.setState({ cards: [{ ...draft("a"), text: "rerun it at 5" }, draft("b")] });
    core.jarvisTurn.mockImplementationOnce(async () => { order.push("turn"); });
    await voice.handleUtterance("yes");
    expect(cards.saveDraftEdit).toHaveBeenCalledTimes(1);
    expect(cards.saveDraftEdit).toHaveBeenCalledWith(api, "a");
    expect(order).toEqual(["save", "turn"]);
  });

  it("names drafts whose edit couldn't be saved, so the server won't approve them", async () => {
    cards.saveDraftEdit.mockResolvedValue(false);
    useJarvis.setState({ cards: [{ ...draft("a"), text: "" }, draft("b")] });
    answer("Okay.");
    await voice.handleUtterance("yes");
    expect(core.jarvisTurn.mock.calls[0][1]).toMatchObject({ unsaved_drafts: ["d_a"] });
  });

  it("leaves closed and expired cards alone: no save, nothing held", async () => {
    useJarvis.setState({ cards: [
      { ...draft("a"), text: "edited", status: "expired" },
      { ...draft("b"), text: "edited", expiresAt: Date.now() - 1000 },
    ] });
    answer("Okay.");
    await voice.handleUtterance("yes");
    expect(cards.saveDraftEdit).not.toHaveBeenCalled();
    expect(core.jarvisTurn.mock.calls[0][1].unsaved_drafts).toBeUndefined();
  });

  it("a dropped connection is one plain error", async () => {
    core.jarvisTurn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await voice.handleUtterance("catch me up");
    expect(useJarvis.getState().error).toBe("Couldn't reach Agora — check the connection and try again.");
    expect(useJarvis.getState().phase).toBe("error");
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
  it("a no-speech transcription keeps listening without an error", async () => {
    await speak("");
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

describe("navigating and hiding by voice", () => {
  const hideEvent = { type: "hide" } as JarvisEvent;

  it("opens the conversation the server resolved", async () => {
    const target = { type: "navigate", group_id: "g1", channel_id: "c1", thread_id: 7, label: "a thread in #release" } as JarvisEvent;
    answerWith([target], "Opening it.");
    await voice.handleUtterance("open the deploy thread");
    expect(nav.jumpTo).toHaveBeenCalledWith(target);
  });

  it("hides the panel once the answer is spoken, without listening again or touching Jarvis mode", async () => {
    useJarvis.getState().setEnabled(true);
    useJarvis.getState().open();
    answerWith([hideEvent], "Hiding. Say Hey Jarvis when you need me.");
    await speak("hide jarvis");
    expect(useJarvis.getState().isOpen).toBe(true); // still speaking
    FakeAudio.instances[0].end(); // "Hiding."
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(true); // the rest is still to come
    FakeAudio.instances[1].end();
    await pass(0);
    const st = useJarvis.getState();
    expect(st.isOpen).toBe(false);
    expect(st.enabled).toBe(true);
    expect(st.micMuted).toBe(false);
    expect(st.micOwned).toBe(false); // the wake word can have the mic back
    expect(voice.voiceDebugState()).toMatchObject({ capture: "off", micOpen: false });
    await pass(voice.FOLLOW_UP_MS * 2);
    expect(env.getUserMedia).toHaveBeenCalledTimes(1); // no follow-up capture
  });

  it("hides at once when nothing is spoken (speaker off or no voice)", async () => {
    voice.configureVoice({ tts: false });
    useJarvis.getState().open();
    answerWith([hideEvent], "Hiding.");
    await voice.handleUtterance("go away");
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(false);
  });

  it("stays open when the same answer offered a draft, or the turn failed", async () => {
    voice.configureVoice({ tts: false });
    useJarvis.getState().open();
    answerWith([{ type: "card", card: draft("a").card } as JarvisEvent, hideEvent], "Drafted for #release: “rerun it”. Send it?");
    await voice.handleUtterance("draft rerun it to release and hide");
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(true);
    core.jarvisTurn.mockImplementationOnce(async (_s: unknown, _r: unknown, onEvent: OnEvent) => {
      onEvent(hideEvent);
      throw new Error("ChatGPT didn't respond — try again.");
    });
    await voice.handleUtterance("hide");
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(useJarvis.getState().error).toBe("ChatGPT didn't respond — try again.");
    // A failure the server streams (rather than throws) keeps it up too, and doesn't reset.
    answerWith([hideEvent, { type: "new_conversation" } as JarvisEvent, { type: "error", message: "ChatGPT didn't respond — try again." } as JarvisEvent]);
    await voice.handleUtterance("start over and hide");
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(core.resetJarvisConversation).not.toHaveBeenCalled();
  });

  it("a newer turn cancels a pending hide", async () => {
    useJarvis.getState().open();
    answerWith([hideEvent], "Hiding.");
    await speak("hide");
    answer("Here is what's new.");
    await voice.handleUtterance("actually, what's new?");
    FakeAudio.instances.at(-1)?.end();
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(true);
  });

  it("starts a new conversation once the answer is spoken, and keeps listening", async () => {
    useJarvis.getState().open();
    answerWith([{ type: "new_conversation" } as JarvisEvent], "Starting fresh.");
    await speak("let's start over");
    expect(core.resetJarvisConversation).not.toHaveBeenCalled(); // still speaking
    expect(useJarvis.getState().log.length).toBeGreaterThan(0);
    FakeAudio.instances[0].end();
    await pass(0);
    expect(core.resetJarvisConversation).toHaveBeenCalledWith(api, "jc1");
    expect(useJarvis.getState().log).toEqual([]);
    expect(useJarvis.getState().conversationId).toBeNull();
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(voice.voiceDebugState()).toMatchObject({ capture: "waiting" });
  });

  it("never switches Jarvis mode, even when it was already off", async () => {
    useJarvis.getState().setEnabled(false);
    useJarvis.getState().open();
    answerWith([hideEvent], "Hiding.");
    voice.configureVoice({ tts: false });
    await voice.handleUtterance("turn off jarvis mode");
    await pass(0);
    expect(useJarvis.getState().enabled).toBe(false);
    expect(useJarvis.getState().isOpen).toBe(false);
  });
});

describe("speed, background speech and Stop", () => {
  it("plays replies at the configured speed, pitch kept", async () => {
    voice.configureVoice({ rate: 1.5 });
    answer("All good.");
    await voice.handleUtterance("status?");
    await pass(0);
    const clip = FakeAudio.instances[0] as unknown as { playbackRate: number; preservesPitch: boolean };
    expect(clip.playbackRate).toBe(1.5);
    expect(clip.preservesPitch).toBe(true);
    voice.configureVoice({ rate: 1 });
  });

  it("records from the moment it listens, and drops a window with no speech", async () => {
    await voice.listen("open");
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0].state).toBe("recording"); // before any speech
    await pass(voice.OPEN_WINDOW_MS + 500);
    expect(FakeRecorder.instances[0].state).toBe("inactive");
    expect(core.jarvisTranscribe).not.toHaveBeenCalled();
  });

  it("keeps speaking after the panel closes, without listening again", async () => {
    answer("Here is the summary.");
    await speak("summarize the deploy thread");
    expect(useJarvis.getState().micOwned).toBe(true);
    voice.panelClosed();
    expect(useJarvis.getState().micOwned).toBe(false); // the wake word can have the mic
    expect(FakeAudio.instances[0].paused).toBe(false); // still talking
    FakeAudio.instances[0].end();
    await pass(voice.FOLLOW_UP_MS * 2);
    expect(voice.voiceDebugState()).toMatchObject({ capture: "off", micOpen: false });
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    voice.configureVoice({ open: true });
  });

  it("drops a transcription that finishes after the panel closed", async () => {
    let finish: (v: { text: string; noSpeech: boolean }) => void = () => {};
    core.jarvisTranscribe.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    await voice.listen("open");
    env.rms = 0.05;
    await pass(500);
    env.rms = 0.001;
    await pass(voice.END_OF_SPEECH_MS + 100);
    expect(core.jarvisTranscribe).toHaveBeenCalledTimes(1);
    voice.panelClosed();
    voice.configureVoice({ open: true });
    await voice.listen("open"); // reopened meanwhile
    finish({ text: "open release", noSpeech: false });
    await pass(0);
    expect(core.jarvisTurn).not.toHaveBeenCalled();
  });

  it("reopening while it still speaks neither chimes nor records over the answer", async () => {
    answer("Here is the summary.");
    await speak("summarize it");
    voice.panelClosed();
    voice.configureVoice({ open: true });
    chime.playChime.mockClear();
    await voice.listen("open");
    expect(chime.playChime).not.toHaveBeenCalled();
    expect(voice.voiceDebugState().capture).toBe("off");
    FakeAudio.instances[0].end();
    await pass(0);
    expect(voice.voiceDebugState().capture).toBe("waiting"); // the follow-up, once spoken
  });

  it("Stop speaking silences the rest while the text keeps coming, then waits quietly", async () => {
    const seen = hangingAnswer("First part. ");
    void voice.handleUtterance("catch me up");
    await pass(0);
    expect(core.jarvisSpeech).toHaveBeenCalledTimes(1);
    voice.stopSpeaking();
    expect(FakeAudio.instances[0]?.paused ?? true).toBe(true);
    expect(seen.signal?.aborted).toBe(false); // the answer keeps streaming
    expect(useJarvis.getState().busy).toBe(true);
    expect(core.jarvisSpeech).toHaveBeenCalledTimes(1); // nothing more is synthesized
  });

  it("after Stop, the finished answer is not followed by listening", async () => {
    answerWith([], "One. ", "Two.");
    await speak("tell me");
    voice.stopSpeaking();
    await pass(voice.FOLLOW_UP_MS);
    expect(voice.voiceDebugState().capture).not.toBe("waiting");
    // The next request speaks again.
    answer("Back.");
    await voice.handleUtterance("and now?");
    await pass(0);
    expect(spokenTexts().at(-1)).toBe("Back.");
  });

  it("Stop releases the mic and still carries out a hide the answer asked for", async () => {
    useJarvis.getState().open();
    answerWith([{ type: "hide" } as JarvisEvent], "Hiding. Say Hey Jarvis when you need me.");
    await speak("hide jarvis");
    expect(useJarvis.getState().audioActive).toBe(true);
    voice.stopSpeaking();
    await pass(0);
    expect(useJarvis.getState().isOpen).toBe(false);
    expect(useJarvis.getState().micOwned).toBe(false);
    expect(useJarvis.getState().audioActive).toBe(false);
  });

  it("a typed turn while a spoken one is transcribing isn't taken over by it", async () => {
    let finish: (v: { text: string; noSpeech: boolean }) => void = () => {};
    core.jarvisTranscribe.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    await voice.listen("open");
    env.rms = 0.05;
    await pass(500);
    env.rms = 0.001;
    await pass(voice.END_OF_SPEECH_MS + 100);
    const seen = hangingAnswer("Working on it.");
    void voice.runTurn("typed question");
    await pass(0);
    finish({ text: "spoken question", noSpeech: false });
    await pass(0);
    expect(core.jarvisTurn).toHaveBeenCalledTimes(1);
    expect(seen.signal?.aborted).toBe(false);
  });

  it("a one-second pause stays in one request; a longer one ends it", async () => {
    core.jarvisTranscribe.mockResolvedValueOnce({ text: "open release and summarize it", noSpeech: false });
    answer("Okay.");
    await voice.listen("open");
    env.rms = 0.05; await pass(500);
    env.rms = 0.001; await pass(1000); // a natural pause
    expect(voice.voiceDebugState().capture).toBe("recording");
    env.rms = 0.05; await pass(500);
    env.rms = 0.001; await pass(voice.END_OF_SPEECH_MS + 100);
    expect(core.jarvisTranscribe).toHaveBeenCalledTimes(1); // one clip, both halves
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("New drops what was recorded while waiting for speech", async () => {
    await voice.listen("open");
    const before = FakeRecorder.instances[0];
    voice.newConversation(api);
    expect(before.state).toBe("inactive");
    expect(FakeRecorder.instances).toHaveLength(2); // a fresh recorder for what comes next
    expect(FakeRecorder.instances[1].state).toBe("recording");
    expect(core.jarvisTranscribe).not.toHaveBeenCalled();
  });

  it("an answer finishing after the panel closed doesn't navigate the user", async () => {
    const target = { type: "navigate", group_id: "g1", channel_id: "c1", thread_id: null, label: "#release" } as JarvisEvent;
    voice.panelClosed();
    answerWith([target], "Opening it.");
    await voice.runTurn("open release");
    expect(nav.jumpTo).not.toHaveBeenCalled();
    voice.configureVoice({ open: true });
  });

  it("restarts the recording while waiting, so a clip carries at most a few seconds of silence", async () => {
    await voice.listen("open");
    await pass(7_000);
    expect(FakeRecorder.instances.length).toBeGreaterThanOrEqual(3);
    expect(FakeRecorder.instances.filter(r => r.state === "recording")).toHaveLength(1);
    expect(core.jarvisTranscribe).not.toHaveBeenCalled();
  });

  it("Stop speaking is marked for the turn, and cleared by the next", async () => {
    hangingAnswer("First part. ");
    void voice.handleUtterance("catch me up");
    await pass(0);
    voice.stopSpeaking();
    expect(useJarvis.getState().speechStopped).toBe(true);
    answer("Back.");
    await voice.handleUtterance("and now?");
    expect(useJarvis.getState().speechStopped).toBe(false);
  });

  it("a soft start near the restart boundary isn't thrown away", async () => {
    await voice.listen("open");
    await pass(2_900);
    env.rms = 0.01; // below the speech threshold: a quiet first syllable
    await pass(300);
    expect(FakeRecorder.instances).toHaveLength(1); // no restart over it
    env.rms = 0.05;
    await pass(300);
    expect(voice.voiceDebugState().capture).toBe("recording");
    expect(FakeRecorder.instances).toHaveLength(1);
  });

  it("New drops a recording or transcription in progress, so it can't start a turn", async () => {
    // Mid-sentence.
    await voice.listen("open");
    env.rms = 0.05;
    await pass(500);
    expect(voice.voiceDebugState().capture).toBe("recording");
    voice.newConversation(api);
    expect(useJarvis.getState().phase).toBe("listening"); // and it says so
    env.rms = 0.001;
    await pass(voice.END_OF_SPEECH_MS + 100);
    expect(core.jarvisTranscribe).not.toHaveBeenCalled();
    // Mid-transcription.
    let finish: (v: { text: string; noSpeech: boolean }) => void = () => {};
    core.jarvisTranscribe.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    env.rms = 0.05;
    await pass(500);
    env.rms = 0.001;
    await pass(voice.END_OF_SPEECH_MS + 100);
    expect(voice.voiceDebugState().capture).toBe("transcribing");
    voice.newConversation(api);
    finish({ text: "the old question", noSpeech: false });
    await pass(0);
    expect(core.jarvisTurn).not.toHaveBeenCalled();
  });

  it("steady room noise can't keep the recording from restarting", async () => {
    await voice.listen("open");
    env.rms = 0.01; // below the speech threshold, all the time
    await pass(7_000);
    expect(FakeRecorder.instances.length).toBeGreaterThanOrEqual(2);
    expect(core.jarvisTranscribe).not.toHaveBeenCalled();
  });

  it("plays clips through Web Audio: silence trimmed, sped up, pitch kept, no element", async () => {
    const sr = 24_000;
    const sound = Float32Array.from({ length: sr }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr));
    const padded = new Float32Array(sr * 2);
    padded.set(sound, sr / 2); // half a second of silence in front, as Orpheus sends it
    const started: { buffer: { length: number } }[] = [];
    const proto = FakeAudioContext.prototype as unknown as Record<string, unknown>;
    proto.decodeAudioData = async () => ({ sampleRate: sr, numberOfChannels: 1, getChannelData: () => padded });
    proto.createBuffer = (_c: number, length: number, rate: number) => ({ length, sampleRate: rate, duration: length / rate, copyToChannel() {} });
    proto.createBufferSource = () => {
      const node = { buffer: null as unknown, onended: null as null | (() => void), connect() {}, disconnect() {}, stop() {},
        start() { started.push(node as never); } };
      return node;
    };
    try {
      voice.configureVoice({ rate: 1.5 });
      answer("All good.");
      await voice.handleUtterance("status?");
      await pass(0);
      expect(started).toHaveLength(1);
      expect(FakeAudio.instances).toHaveLength(0);
      // ~1 s of sound (+ pads), at 1.5×: about two thirds of a second, not two.
      expect(started[0].buffer.length / sr).toBeGreaterThan(0.6);
      expect(started[0].buffer.length / sr).toBeLessThan(0.8);
      expect(useJarvis.getState().audioActive).toBe(true);
      (started[0] as unknown as { onended: () => void }).onended();
      await pass(0);
      expect(useJarvis.getState().audioActive).toBe(false);
    } finally {
      delete proto.decodeAudioData;
      delete proto.createBuffer;
      delete proto.createBufferSource;
      voice.configureVoice({ rate: 1 });
    }
  });
});

