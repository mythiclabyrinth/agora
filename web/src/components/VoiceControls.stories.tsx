import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useLiveVoice } from "../state/liveVoice";
import { useSpeak } from "../state/speak";
import { useVoiceRec } from "../state/voiceRec";
import { LiveButton, LiveStrip, MicButton, SpeakButton } from "./VoiceControls";

type VoiceState = "idle" | "recording" | "recording-legacy" | "transcribing" | "live"
  | "live-muted" | "live-muted-speaker-off" | "live-thinking-muted" | "live-speaking-muted";

function VoiceSurface({ state }: { state: VoiceState }) {
  return (
    <div
      className="agora-main"
      style={{ width: "min(720px, 100%)", height: "min(680px, calc(100vh - 28px))" }}
    >
      <div className="ago-head">
        <div className="ago-head-text">
          <strong># general</strong><span className="dim">Component review</span>
        </div>
        <div className="ago-head-actions">
          <SpeakButton />
          <LiveButton channelId="general" threadId={null} />
        </div>
      </div>
      <div className="ago-log">
        <div className="bubble user">
          <div className="who"><span className="who-name">Tom</span></div>
          Can you verify the voice controls in their real channel positions?
        </div>
        <div className="bubble assistant">
          <div className="who"><span className="who-name">Codex · agent</span></div>
          The header owns speak-aloud and Live; the composer owns voice-note recording.
        </div>
        <div className="bubble assistant">
          <div className="who"><span className="who-name">Claude · agent</span></div>
          Recording, transcribing, and live-thinking states should remain visible at phone, tablet, and desktop widths.
        </div>
      </div>
      <LiveStrip channelId="general" threadId={null} />
      <div className="chat-input">
        <textarea aria-label="Message preview" placeholder="Message #general" />
        <MicButton channelId="general" threadId={null} draftOK={state !== "recording-legacy"} />
        <button className="btn primary">Send</button>
      </div>
      <span hidden>{state}</span>
    </div>
  );
}

function setup(state: VoiceState) {
  const live = state.startsWith("live");
  const muted = state.includes("muted");
  useVoiceRec.setState({
    recordingKey: state === "recording" || state === "recording-legacy" ? "c:general" : null,
    startedAt: Date.now() - 12_000,
    busyKey: state === "transcribing" ? "c:general" : null,
  });
  useLiveVoice.setState({
    scope: live ? { channelId: "general", threadId: null } : null,
    state: state === "live" || state === "live-thinking-muted"
      ? "thinking"
      : state === "live-speaking-muted" ? "speaking" : "listening",
    muted,
  });
  useSpeak.setState({ on: live && state !== "live-muted-speaker-off" });
}

const meta = {
  title: "Web/Voice/Production placement",
  component: VoiceSurface,
  args: { state: "idle" },
  parameters: { setup: () => setup("idle") },
} satisfies Meta<typeof VoiceSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};
export const Recording: Story = {
  args: { state: "recording" },
  parameters: { setup: () => setup("recording") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByTitle("Stop and add to message")).resolves.toBeVisible();
    await expect(canvas.findByTitle("Stop and send")).resolves.toBeVisible();
  },
};
export const RecordingWithoutDraftCapability: Story = {
  args: { state: "recording-legacy" },
  parameters: { setup: () => setup("recording-legacy") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByTitle("Stop and add to message")).not.toBeInTheDocument();
    await expect(canvas.findByTitle("Stop and send")).resolves.toBeVisible();
  },
};
export const Transcribing: Story = {
  args: { state: "transcribing" },
  parameters: { setup: () => setup("transcribing") },
};
export const LiveThinking: Story = {
  args: { state: "live" },
  parameters: {
    setup: () => setup("live"),
    docs: {
      description: {
        story: "The pane header owns speak-aloud and Live. Messages fill the middle; live status sits immediately above the composer, matching production.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("Thinking…")).resolves.toBeVisible();
  },
};

export const LiveMuted: Story = {
  args: { state: "live-muted" },
  parameters: { setup: () => setup("live-muted") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Muted — tap Unmute to talk")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    const dot = canvasElement.querySelector<HTMLElement>(".ago-live-dot");
    await expect(dot).not.toBeNull();
    const faint = getComputedStyle(canvasElement).getPropertyValue("--faint").trim();
    const probe = document.createElement("span");
    probe.style.color = faint;
    canvasElement.appendChild(probe);
    const expectedMutedColor = getComputedStyle(probe).color;
    probe.remove();
    await expect(getComputedStyle(dot!).backgroundColor).toBe(expectedMutedColor);
  },
};

export const LiveMutedSpeakerOff: Story = {
  args: { state: "live-muted-speaker-off" },
  parameters: { setup: () => setup("live-muted-speaker-off") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Muted — replies appear in chat")).toBeVisible();
  },
};

export const LiveThinkingMuted: Story = {
  args: { state: "live-thinking-muted" },
  parameters: { setup: () => setup("live-thinking-muted") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Thinking…")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
  },
};

export const LiveSpeakingMuted: Story = {
  args: { state: "live-speaking-muted" },
  parameters: { setup: () => setup("live-speaking-muted") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Speaking — talk to interrupt")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
  },
};
