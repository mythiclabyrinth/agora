import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const cancelJarvisDraft = vi.fn(() => Promise.resolve({ ok: true, cancelled: true }));
vi.mock("@agora/core", async (orig) => ({ ...(await orig<object>()), cancelJarvisDraft }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../state/ui", () => ({ useUiState: { getState: () => ({}) } }));
vi.mock("../../state/jump", () => ({ useJump: { getState: () => ({}) } }));
vi.mock("../../lib/icons", () => ({ Icon: () => null }));

const { useJarvis } = await import("../../state/jarvis");
const { dismissCardEntry } = await import("./JarvisCards");
const api = {} as never;

const draft = (status?: "pending" | "sending" | "sent") => ({
  id: "jc1", status,
  card: { kind: "draft", draft_id: "jd_1", channel_id: "c", channel_name: "release", group_id: "g", group_name: "G",
    thread_id: null, destination: "#release", text: "t", final_text: "t", mentions: [], expires_in: 120 },
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
