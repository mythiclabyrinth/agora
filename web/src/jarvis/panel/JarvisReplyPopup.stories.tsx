import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useJarvis } from "../../state/jarvis";
import { JarvisReplyPopup } from "./JarvisReplyPopup";

const jarvisMe = { ...fixtureMe, jarvis: true, jarvis_hint: null, jarvis_stt: true, jarvis_tts: true };
const answer = "Two agents are online: Claude and Codex. Codex reran the deploy at 5pm and it is green now. "
  + "Claude is reviewing the release notes and will post them in #release within the hour. Nothing needs you yet.";
const said = (role: "user" | "assistant", text: string, id: string) => ({ id, role, text });

const meta = {
  title: "Web/Jarvis/Reply pop-up",
  component: JarvisReplyPopup,
  decorators: [(Story) => <div className="topbar" style={{ padding: 12, justifyContent: "flex-end", minHeight: 360 }}>
    <div className="jv-chip-wrap"><button className="jv-chip is-on">Jarvis mode</button><Story /></div></div>],
  parameters: { apiRoutes: { "GET /api/me": jarvisMe } },
} satisfies Meta<typeof JarvisReplyPopup>;

export default meta;
type Story = StoryObj<typeof meta>;

const speaking = () => useJarvis.setState({
  enabled: true, isOpen: false, busy: false, audioActive: true, phase: "speaking",
  log: [said("user", "what's happening in release?", "u1"), said("assistant", answer, "a1")],
  spoken: { id: "a1", start: 0, end: answer.indexOf(".") + 1 }, cards: [],
});

export const Speaking: Story = {
  parameters: { setup: speaking },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const popup = await canvas.findByTestId("jarvis-popup");
    expect(within(popup).getByRole("status")).toHaveTextContent("Jarvis is replying"); // a short status, not the stream
    expect(canvas.getByText("what's happening in release?")).toBeVisible();
    expect(canvas.getByText("Two agents are online: Claude and Codex.")).toHaveClass("jv-spoken");
    // Collapsed to a few lines; a click expands it (and collapses it again).
    const body = popup.querySelector(".jv-popup-body") as HTMLElement;
    const collapsed = body.clientHeight;
    await userEvent.click(body);
    expect(popup).toHaveClass("is-expanded");
    expect(body.clientHeight).toBeGreaterThan(collapsed);
    expect(document.activeElement).not.toBe(body); // never steals focus
    await userEvent.click(body);
    expect(popup).not.toHaveClass("is-expanded");
    // Stop speaking while it talks; open the panel; no Reply mid-answer.
    expect(canvas.getByRole("button", { name: "Stop speaking" })).toBeVisible();
    expect(canvas.queryByRole("button", { name: "Reply" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Open the assistant" }));
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(canvas.queryByTestId("jarvis-popup")).toBeNull(); // the panel shows it now
  },
};

export const Dismissed: Story = {
  parameters: { setup: speaking },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("jarvis-popup");
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
    expect(canvas.queryByTestId("jarvis-popup")).toBeNull();
  },
};

export const Lingers: Story = {
  name: "Lingers, then offers Reply",
  parameters: { setup: speaking },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("jarvis-popup");
    useJarvis.setState({ audioActive: false, phase: "armed", spoken: null });
    // Done speaking: still shown for a few seconds, now with Reply.
    await expect(canvas.findByRole("button", { name: "Reply" })).resolves.toBeVisible();
    expect(canvas.queryByRole("button", { name: "Stop speaking" })).toBeNull();
  },
};

export const DraftWaiting: Story = {
  parameters: {
    setup: () => {
      speaking();
      useJarvis.setState({
        cards: [{ id: "c1", status: "pending", expiresAt: Date.now() + 600_000, card: {
          kind: "draft", draft_id: "d1", channel_id: "ch", channel_name: "release", group_id: "g", group_name: "Eng", thread_id: null,
          destination: "#release", text: "Deploy is green", final_text: "Deploy is green", mentions: [], expires_in: 600, revision: 1,
        } }],
      });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const draft = await canvas.findByTestId("jarvis-popup-draft");
    expect(within(draft).getByText("#release")).toBeVisible();
    expect(within(draft).getByRole("button", { name: "Send" })).toBeVisible();
    await userEvent.click(within(draft).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(useJarvis.getState().cards[0].status).toBe("cancelled"));
    expect(canvas.queryByTestId("jarvis-popup-draft")).toBeNull();
  },
};

export const HiddenWhenPanelOpenOrModeOff: Story = {
  parameters: { setup: () => { speaking(); useJarvis.setState({ isOpen: true }); } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByTestId("jarvis-popup")).toBeNull();
    useJarvis.setState({ isOpen: false, enabled: false });
    expect(canvas.queryByTestId("jarvis-popup")).toBeNull();
  },
};

export const ListeningAnew: Story = {
  name: "Listening for a new request (no old reply)",
  parameters: { setup: () => { speaking(); useJarvis.setState({ audioActive: false, phase: "recording", spoken: null }); } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("jarvis-popup");
    expect(canvas.getAllByText("Listening…").length).toBeGreaterThan(0);
    expect(canvas.queryByText("what's happening in release?")).toBeNull();
    expect(canvas.queryByText(/Two agents are online/)).toBeNull();
    // Listening with the panel closed always offers a way to stop it.
    expect(canvas.getByRole("button", { name: "Stop listening" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
    expect(useJarvis.getState().phase).not.toBe("recording"); // Dismiss stops listening
    expect(canvas.queryByText("Listening…")).toBeNull();
  },
};

export const BackgroundError: Story = {
  parameters: { setup: speaking },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("jarvis-popup");
    // The answer ends in an error: still visible (it lingers) and says what went wrong.
    useJarvis.setState({ audioActive: false, phase: "error", error: "ChatGPT didn't respond — try again." });
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent("ChatGPT didn't respond");
  },
};

