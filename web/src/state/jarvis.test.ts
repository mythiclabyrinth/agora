import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { useJarvis } = await import("./jarvis");
const initial = useJarvis.getState();

describe("useJarvis", () => {
  beforeEach(() => {
    storage.clear();
    useJarvis.setState(initial, true);
  });

  it("persists the Jarvis mode toggle per device and rests armed when on", () => {
    expect(useJarvis.getState().enabled).toBe(false);
    useJarvis.getState().toggleEnabled();
    expect(storage.get("agora_jarvis_enabled")).toBe("1");
    expect(useJarvis.getState().phase).toBe("armed");
    useJarvis.getState().setEnabled(false);
    expect(storage.get("agora_jarvis_enabled")).toBe("0");
    expect(useJarvis.getState().phase).toBe("idle");
  });

  it("Hey Jarvis listens in the background by default, per device", () => {
    expect(useJarvis.getState().wakeBackground).toBe(true); // nothing stored yet
    useJarvis.getState().setWakeBackground(false);
    expect(storage.get("agora_jarvis_wake_background")).toBe("0");
    expect(useJarvis.getState().wakeBackground).toBe(false);
  });

  it("open(text) opens the panel and queues one turn for it", () => {
    useJarvis.getState().open("catch me up");
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(useJarvis.getState().takePendingAsk()).toBe("catch me up");
    expect(useJarvis.getState().takePendingAsk()).toBeNull();
    useJarvis.getState().open();
    expect(useJarvis.getState().pendingAsk).toBeNull();
    useJarvis.getState().close();
    expect(useJarvis.getState().isOpen).toBe(false);
  });

  it("reduces a streamed turn into phase, caption, cards, and conversation id", () => {
    const s = () => useJarvis.getState();
    s().beginTurn("catch me up");
    expect(s()).toMatchObject({ busy: true, phase: "thinking", transcript: "catch me up", caption: "" });
    s().applyEvent({ type: "start", conversation_id: "jc_1" });
    s().applyEvent({ type: "status", phase: "searching", label: "Checking your unreads" });
    expect(s()).toMatchObject({ phase: "searching", label: "Checking your unreads" });
    s().applyEvent({ type: "card", card: { kind: "digest", items: [] } });
    s().applyEvent({ type: "card", card: { kind: "draft", draft_id: "jd", channel_id: "c", channel_name: "general", group_id: "g", group_name: "G",
      thread_id: null, destination: "#general", text: "hi", final_text: "hi", mentions: [], expires_in: 120, revision: 1 } });
    expect(s().cards.map(c => c.card.kind)).toEqual(["draft", "digest"]);
    expect(s().cards[0].status).toBe("pending");
    s().applyEvent({ type: "delta", text: "Two " });
    s().applyEvent({ type: "delta", text: "threads need you." });
    expect(s()).toMatchObject({ phase: "speaking", caption: "Two threads need you." });
    s().applyEvent({ type: "done", conversation_id: "jc_1", text: "Two threads need you." });
    expect(s()).toMatchObject({ busy: false, phase: "idle", conversationId: "jc_1" });
    s().setCardStatus(s().cards[0].id, "sent");
    expect(s().cards[0].status).toBe("sent");
    s().dismissCard(s().cards[1].id);
    expect(s().cards).toHaveLength(1);
    s().reset();
    expect(s()).toMatchObject({ conversationId: null, cards: [], caption: "" });
  });

  it("surfaces errors as a paused error phase", () => {
    useJarvis.getState().beginTurn("x");
    useJarvis.getState().applyEvent({ type: "error", message: "Jarvis mode needs ChatGPT" });
    expect(useJarvis.getState()).toMatchObject({ busy: false, phase: "error", error: "Jarvis mode needs ChatGPT" });
    useJarvis.getState().beginTurn("y");
    expect(useJarvis.getState().error).toBeNull();
    useJarvis.getState().failTurn("network down");
    expect(useJarvis.getState().phase).toBe("error");
  });

  it("tracks the wake word's mic state and keeps only the latest error", () => {
    expect(useJarvis.getState().wake).toBe("off");
    useJarvis.getState().setWake("error", "Microphone access is off.");
    expect(useJarvis.getState().wakeError).toBe("Microphone access is off.");
    useJarvis.getState().setWake("listening");
    expect(useJarvis.getState()).toMatchObject({ wake: "listening", wakeError: null });
    useJarvis.getState().setWake("error");
    expect(useJarvis.getState().wakeError).toBe("The wake word stopped.");
  });

  it("walks a voice turn: listening → thinking → speaking → listening → armed", () => {
    const s = () => useJarvis.getState();
    s().setEnabled(true);
    s().open();
    expect(s().listenSeq).toBe(1);
    s().setVoicePhase("listening");
    expect(s().phase).toBe("listening");
    s().setVoicePhase("recording");
    s().setVoicePhase("transcribing");
    expect(s().phase).toBe("transcribing");
    s().beginTurn("what agents are online");
    expect(s().phase).toBe("thinking");
    // The loop cannot pull a running turn back to listening…
    s().setVoicePhase("listening");
    expect(s().phase).toBe("thinking");
    s().applyEvent({ type: "delta", text: "Two agents " });
    s().applyEvent({ type: "delta", text: "are online." });
    expect(s().phase).toBe("speaking");
    expect(s().log.map(e => [e.role, e.text])).toEqual([["user", "what agents are online"], ["assistant", "Two agents are online."]]);
    s().applyEvent({ type: "done", conversation_id: "jc_1", text: "Two agents are online." });
    expect(s().phase).toBe("armed");
    // …but playback of the answer still shows as speaking, then the follow-up.
    s().setVoicePhase("speaking");
    s().setSpoken({ id: s().log[1].id, start: 0, end: 22 });
    expect(s().phase).toBe("speaking");
    s().setVoicePhase("listening");
    expect(s().phase).toBe("listening");
    s().setVoicePhase(null);
    expect(s()).toMatchObject({ phase: "armed", spoken: null });
  });

  it("mute is per device, drops listening, and blocks new captures", () => {
    const s = () => useJarvis.getState();
    s().setEnabled(true);
    s().setVoicePhase("listening");
    s().setMicMuted(true);
    expect(storage.get("agora_jarvis_mic_muted")).toBe("1");
    expect(s()).toMatchObject({ micMuted: true, phase: "armed" });
    s().setVoicePhase("listening");
    s().setVoicePhase("recording");
    expect(s().phase).toBe("armed");
    s().setMicMuted(false);
    s().setVoicePhase("listening");
    expect(s().phase).toBe("listening");
    s().setSpeakerOff(true);
    expect(storage.get("agora_jarvis_speaker_off")).toBe("1");
    expect(s().speakerOff).toBe(true);
  });

  it("keeps the transcript across turns, drops empty answers on failure, and resets", () => {
    const s = () => useJarvis.getState();
    s().beginTurn("first");
    s().applyEvent({ type: "done", conversation_id: "jc", text: "One." });
    s().beginTurn("second");
    s().failTurn("network down");
    s().heard("send it");
    s().say("Sent to #release.");
    expect(s().log.map(e => `${e.role}:${e.text}`)).toEqual([
      "user:first", "assistant:One.", "user:second", "user:send it", "assistant:Sent to #release.",
    ]);
    s().reset();
    expect(s().log).toEqual([]);
  });

  it("applies the server's draft_sent and draft_cancelled to the matching card only", () => {
    const s = () => useJarvis.getState();
    const mk = (draft_id: string) => ({ kind: "draft" as const, draft_id, channel_id: "c", channel_name: "release", group_id: "g",
      group_name: "G", thread_id: null, destination: "#release", text: "t", final_text: "t", mentions: [], expires_in: 120, revision: 3 });
    s().applyEvent({ type: "card", card: mk("jd_a") });
    s().applyEvent({ type: "card", card: mk("jd_b") });
    s().applyEvent({ type: "card", card: mk("jd_c") });
    expect(s().cards[0]).toMatchObject({ revision: 3, savedText: "t" });
    s().applyEvent({ type: "draft_sent", draft_id: "jd_a", message: { id: 77 } as never });
    s().applyEvent({ type: "draft_cancelled", draft_id: "jd_b", superseded_by: "jd_c" });
    // A cancel never reopens or overrides a sent card.
    s().applyEvent({ type: "draft_cancelled", draft_id: "jd_a", superseded_by: null });
    expect(s().cards.map(c => [c.card.kind === "draft" && c.card.draft_id, c.status])).toEqual([
      ["jd_c", "pending"], ["jd_b", "cancelled"], ["jd_a", "sent"],
    ]);
    expect(s().cards[2].messageId).toBe(77);
  });

  it("keeps a draft card's edited text so a spoken confirm sends what is shown", () => {
    useJarvis.getState().applyEvent({ type: "card", card: {
      kind: "draft", draft_id: "jd_1", channel_id: "c", channel_name: "release", group_id: "g", group_name: "G",
      thread_id: null, destination: "#release", text: "ship it", final_text: "ship it", mentions: [], expires_in: 120,
      revision: 1,
    } });
    const id = useJarvis.getState().cards[0].id;
    expect(useJarvis.getState().cards[0].text).toBeUndefined();
    const expiresAt = useJarvis.getState().cards[0].expiresAt ?? 0;
    expect(Math.abs(expiresAt - (Date.now() + 120_000))).toBeLessThan(1000);
    useJarvis.getState().setCardText(id, "ship it after the review");
    expect(useJarvis.getState().cards[0].text).toBe("ship it after the review");
  });

  it("treats schedule drafts and changes as confirmable cards, and marks them applied", () => {
    const s = () => useJarvis.getState();
    const schedule = { id: "s1", status: "active", next_runs: [1], schedule: { kind: "interval", seconds: 3600 } } as never;
    s().applyEvent({ type: "card", card: {
      kind: "schedule_draft", draft_id: "jd_s", revision: 1, channel_id: "c", channel_name: "release", group_id: "g", group_name: "G",
      thread_id: null, destination: "#release", text: "standup", final_text: "@helper standup", mentions: [],
      schedule: { kind: "interval", seconds: 3600 }, run_at: 1, next_runs: [1, 2, 3], dst_note: null, expires_in: 120,
    } });
    s().applyEvent({ type: "card", card: {
      kind: "schedule_change", draft_id: "jd_c", revision: 1, action: "pause", summary: "Pause it", destination: "#release",
      schedule, after: { status: "paused", schedule: { kind: "interval", seconds: 3600 }, run_at: 1, next_runs: [] },
      dst_note: null, expires_in: 120,
    } });
    s().applyEvent({ type: "card", card: { kind: "schedules", items: [], total: 0, offset: 0, has_more: false, truncated: false } });
    const [list, change, create] = s().cards;
    expect(list.status).toBeUndefined();
    expect(change).toMatchObject({ status: "pending", revision: 1, savedText: undefined });
    expect(create).toMatchObject({ status: "pending", revision: 1, savedText: "standup" });
    s().applyEvent({ type: "schedule_applied", draft_id: "jd_s", action: "create", schedule });
    s().applyEvent({ type: "draft_cancelled", draft_id: "jd_c", superseded_by: "jd_c2" });
    expect(s().cards.map(c => c.status)).toEqual([undefined, "cancelled", "sent"]);
    expect(s().cards[2].schedule).toBe(schedule);
    // A message draft's draft_sent never touches a schedule card with the same id.
    s().applyEvent({ type: "draft_sent", draft_id: "jd_s", message: { id: 9 } as never });
    expect(s().cards[2].messageId).toBeUndefined();
  });
});
