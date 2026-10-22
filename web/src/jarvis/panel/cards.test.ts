import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const cancelJarvisDraft = vi.fn(() => Promise.resolve({ ok: true, cancelled: true }));
const updateJarvisDraft = vi.fn();
const sendJarvisDraft = vi.fn();
const toast = vi.fn();
vi.mock("@agora/core", async (orig) => ({ ...(await orig<object>()), cancelJarvisDraft, updateJarvisDraft, sendJarvisDraft }));
vi.mock("../../lib/toast", () => ({ toast }));
vi.mock("../../state/ui", () => ({ useUiState: { getState: () => ({}) } }));
vi.mock("../../state/jump", () => ({ useJump: { getState: () => ({}) } }));
vi.mock("../../lib/icons", () => ({ Icon: () => null }));

const { ApiError } = await import("@agora/core");
const { isLiveDraft, useJarvis } = await import("../../state/jarvis");
const { dismissCardEntry, saveDraftEdit, scheduleDraftSave, sendDraftEntry, SAVE_DEBOUNCE_MS } = await import("./JarvisCards");
const { splitCards } = await import("./derive");
const api = {} as never;

const draft = (status?: "pending" | "sending" | "sent") => ({
  id: "jc1", status,
  card: { kind: "draft", draft_id: "jd_1", channel_id: "c", channel_name: "release", group_id: "g", group_name: "G",
    thread_id: null, destination: "#release", text: "t", final_text: "t", mentions: [], expires_in: 120, revision: 1 },
}) as never;

describe("dismissing a card", () => {
  beforeEach(() => { cancelJarvisDraft.mockClear(); useJarvis.setState({ cards: [] }); });

  it("discards a pending draft on the server, then hides it", () => {
    const entry = draft("pending");
    useJarvis.setState({ cards: [entry] });
    dismissCardEntry(api, entry);
    expect(cancelJarvisDraft).toHaveBeenCalledWith(api, "jd_1");
    expect(useJarvis.getState().cards).toEqual([]);
  });

  it("only hides a draft that is sending or already sent", () => {
    for (const status of ["sending", "sent"] as const) {
      const entry = draft(status);
      useJarvis.setState({ cards: [entry] });
      dismissCardEntry(api, entry);
      expect(useJarvis.getState().cards).toEqual([]);
    }
    expect(cancelJarvisDraft).not.toHaveBeenCalled();
  });
});

type Entry = import("../../state/jarvis").JarvisCardEntry;
const card = (over: Partial<Entry> = {}): Entry => ({ ...(draft("pending") as Entry), savedText: "t", revision: 1, ...over });
const shown = () => useJarvis.getState().cards[0];

describe("draft edits and sends", () => {
  beforeEach(() => {
    vi.useRealTimers();
    updateJarvisDraft.mockReset();
    sendJarvisDraft.mockReset();
    toast.mockClear();
    useJarvis.setState({ cards: [] });
  });

  it("saves an edit, then sends at the revision it produced", async () => {
    useJarvis.setState({ cards: [card({ text: "t, after review" })] });
    updateJarvisDraft.mockResolvedValue({ ok: true, draft_id: "jd_1", revision: 2, text: "t, after review", final_text: "t, after review" });
    sendJarvisDraft.mockResolvedValue({ ok: true, message: { id: 5 }, already_sent: false });
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(true);
    expect(updateJarvisDraft).toHaveBeenCalledWith(api, "jd_1", "t, after review", 1);
    expect(sendJarvisDraft).toHaveBeenCalledWith(api, "jd_1", 2);
    expect(shown()).toMatchObject({ status: "sent", messageId: 5, revision: 2, savedText: "t, after review" });
    expect(toast).toHaveBeenCalledWith("Sent to #release", expect.objectContaining({ actionLabel: "Undo" }));
  });

  it("skips the save when nothing changed, and no second toast when a spoken yes already sent it", async () => {
    useJarvis.setState({ cards: [card()] });
    sendJarvisDraft.mockResolvedValue({ ok: true, message: { id: 5 }, already_sent: true });
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(true);
    expect(updateJarvisDraft).not.toHaveBeenCalled();
    expect(sendJarvisDraft).toHaveBeenCalledWith(api, "jd_1", 1);
    expect(toast).not.toHaveBeenCalled();
    expect(shown().status).toBe("sent");
  });

  it("a stale revision keeps the draft pending and says so; a gone draft shows as expired", async () => {
    useJarvis.setState({ cards: [card()] });
    sendJarvisDraft.mockRejectedValueOnce(new ApiError(409, "This draft changed since you reviewed it"));
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(false);
    expect(shown().status).toBe("pending");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("changed since you reviewed it"), { variant: "warn" });
    sendJarvisDraft.mockRejectedValueOnce(new ApiError(410, "This draft expired"));
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(false);
    expect(shown().status).toBe("expired");
  });

  it("a failed save never sends", async () => {
    useJarvis.setState({ cards: [card({ text: "edited" })] });
    updateJarvisDraft.mockRejectedValueOnce(new ApiError(409, "This draft changed since you reviewed it"));
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(false);
    expect(sendJarvisDraft).not.toHaveBeenCalled();
    expect(shown().status).toBe("pending");
  });

  it("refuses an empty draft without calling the server", async () => {
    useJarvis.setState({ cards: [card({ text: "   " })] });
    expect(await sendDraftEntry(api, shown(), shown().card as never)).toBe(false);
    expect(updateJarvisDraft).not.toHaveBeenCalled();
    expect(sendJarvisDraft).not.toHaveBeenCalled();
  });

  it("debounces typing into one save, and serializes saves so each quotes the last revision", async () => {
    vi.useFakeTimers();
    let rev = 1;
    updateJarvisDraft.mockImplementation(async (_api: unknown, _id: string, text: string, from: number) => {
      expect(from).toBe(rev);
      rev += 1;
      return { ok: true, draft_id: "jd_1", revision: rev, text, final_text: text };
    });
    useJarvis.setState({ cards: [card()] });
    for (const t of ["t,", "t, a", "t, af"]) {
      useJarvis.getState().setCardText("jc1", t);
      scheduleDraftSave(api, "jc1");
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS / 2);
    }
    expect(updateJarvisDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(updateJarvisDraft).toHaveBeenCalledTimes(1);
    expect(shown()).toMatchObject({ revision: 2, savedText: "t, af" });
    useJarvis.getState().setCardText("jc1", "one");
    const first = saveDraftEdit(api, "jc1");
    useJarvis.getState().setCardText("jc1", "two");
    const second = saveDraftEdit(api, "jc1");
    expect(await Promise.all([first, second])).toEqual([true, true]);
    // Each save reads the card when its turn comes: the latest text goes
    // once, from the latest revision, and the queued one has nothing left to do.
    expect(updateJarvisDraft).toHaveBeenCalledTimes(2);
    expect(shown()).toMatchObject({ revision: 3, savedText: "two" });
    vi.useRealTimers();
  });
});

describe("expired drafts", () => {
  it("are not live once past expiresAt, even before the countdown marks them", () => {
    const now = Date.now();
    expect(isLiveDraft(card({ expiresAt: now + 1000 }), now)).toBe(true);
    expect(isLiveDraft(card({ expiresAt: now - 1 }), now)).toBe(false);
    expect(isLiveDraft(card({ status: "sent", expiresAt: now + 1000 }), now)).toBe(false);
    // And they fold away with other finished results.
    const digest = { id: "d", card: { kind: "digest", items: [] } } as Entry;
    const { primary } = splitCards([digest, card({ id: "old", expiresAt: now - 1 }), card({ id: "live", expiresAt: now + 60_000 })]);
    expect(primary.map(c => c.id)).toEqual(["d", "live"]);
  });
});
