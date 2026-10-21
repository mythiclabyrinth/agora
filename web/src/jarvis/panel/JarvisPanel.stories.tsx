import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { JarvisCard } from "@agora/core";
import { fixtureMe, fixtureRootMessage } from "@agora/core/testing/fixtures";
import { useJarvis, type JarvisCardEntry, type JarvisLogEntry, type JarvisState } from "../../state/jarvis";
import { useUiState } from "../../state/ui";
import { JarvisPanel } from "./JarvisPanel";

const jarvisMe = { ...fixtureMe, jarvis: true, jarvis_hint: null };
const voiceMe = { ...jarvisMe, jarvis_stt: true, jarvis_tts: true };

/* Stories never open a real mic: a voice-enabled panel asks for one on
   mount, so park that request (it never resolves) and show the state the
   story sets. */
function parkMic() {
  if (!navigator.mediaDevices) return;
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true, value: () => new Promise<MediaStream>(() => {}),
  });
}

const said = (role: JarvisLogEntry["role"], text: string, id = `story-${role}-${text.length}`): JarvisLogEntry => ({ id, role, text });
const answer = "Two agents are online: Claude and Codex. Claude is in #release and Codex is idle.";

const digest: JarvisCard = {
  kind: "digest",
  items: [
    {
      channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
      thread_id: 101, thread_title: "Release checklist",
      gist: "Claude finished the release notes and is waiting for your sign-off on the changelog.",
      needs_you: true, unread: 4, mentions: 1,
    },
    {
      channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
      thread_id: null,
      gist: "Codex reran the deploy; staging is green again after the cache fix.",
      needs_you: false, unread: 7, mentions: 0,
    },
  ],
};

const draft: JarvisCard = {
  kind: "draft",
  draft_id: "jd_story",
  channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
  thread_id: null, destination: "#storybook",
  text: "@claude please rerun the deploy once the linter passes.",
  final_text: "@claude please rerun the deploy once the linter passes.",
  mentions: [{ kind: "agent", id: "claude", name: "Claude", handle: "claude" }],
  expires_in: 120,
};

const entry = (id: string, card: JarvisCard): JarvisCardEntry => ({
  id, card, status: card.kind === "draft" ? "pending" : undefined,
});

function open(state: Partial<JarvisState>) {
  return () => {
    parkMic();
    useJarvis.setState({ enabled: true, isOpen: true, phase: "armed", wake: "listening", ...state });
  };
}

const sendDraft = fn(() => ({ ok: true, message: { ...fixtureRootMessage, id: 9001 } }));

const meta = {
  title: "Web/Jarvis/Panel",
  component: JarvisPanel,
  parameters: {
    apiRoutes: { "GET /api/me": jarvisMe },
    setup: open({}),
  },
} satisfies Meta<typeof JarvisPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Armed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("dialog", { name: "Agora assistant" });
    expect(within(panel).getByText("Jarvis mode is on — ask me anything")).toBeVisible();
    await waitFor(() => expect(within(panel).getByLabelText("Ask Agora")).toHaveFocus());
    expect(within(panel).getByRole("button", { name: "Ask" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(useJarvis.getState().isOpen).toBe(false));
  },
};

export const Searching: Story = {
  parameters: {
    setup: open({
      busy: true, phase: "searching", label: "Searching messages for “deploy”",
      transcript: "what happened with the deploy?", conversationId: "jc_story",
      log: [said("user", "what happened with the deploy?"), said("assistant", "")],
    }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    expect(panel.getByText("Searching messages for “deploy”")).toBeVisible();
    expect(panel.getByText("what happened with the deploy?")).toBeVisible();
    expect(panel.getByPlaceholderText("Working…")).toBeVisible();
    expect(panel.getByRole("button", { name: "Ask" })).toBeDisabled();
  },
};

export const Digest: Story = {
  parameters: {
    setup: open({
      transcript: "catch me up", conversationId: "jc_story",
      caption: "Two conversations moved: the release thread needs your sign-off.",
      log: [said("user", "catch me up"), said("assistant", "Two conversations moved: the release thread needs your sign-off.")],
      cards: [entry("jc-digest", digest)],
    }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const card = within(panel.getByTestId("jarvis-digest"));
    expect(card.getByText("Needs you")).toBeVisible();
    expect(card.getByText("4 new")).toBeVisible();
    await userEvent.click(card.getByRole("button", { name: "Open thread →" }));
    expect(useUiState.getState().sel.c).toBe("general");
    expect(useUiState.getState().threadRoot).toBe(101);
  },
};

export const Draft: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": jarvisMe,
      "POST /api/jarvis/drafts/jd_story/send": sendDraft,
    },
    setup: open({
      transcript: "tell Claude in #storybook to rerun the deploy", conversationId: "jc_story",
      caption: "Drafted it for #storybook: “@claude please rerun the deploy once the linter passes.” Send it?",
      log: [
        said("user", "tell Claude in #storybook to rerun the deploy"),
        said("assistant", "Drafted it for #storybook: “@claude please rerun the deploy once the linter passes.” Send it?"),
      ],
      cards: [entry("jc-draft", draft)],
    }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const card = within(panel.getByTestId("jarvis-draft"));
    expect(card.getByText("@claude")).toBeVisible();
    const text = card.getByLabelText("Draft message");
    expect(text).toHaveAttribute("readonly");
    await userEvent.click(card.getByRole("button", { name: "Edit" }));
    await userEvent.type(text, " Thanks!");
    await userEvent.click(card.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith(expect.objectContaining({
      text: "@claude please rerun the deploy once the linter passes. Thanks!",
    })));
    await expect(card.findByText("Sent")).resolves.toBeVisible();
  },
};

export const TurnError: Story = {
  name: "Error",
  parameters: {
    setup: open({
      phase: "error", transcript: "catch me up", error: "ChatGPT is not connected. Ask an admin to connect it in Settings.",
    }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const status = panel.getByText("ChatGPT is not connected. Ask an admin to connect it in Settings.");
    expect(status).toHaveClass("is-error");
    // The input stays usable so the user can retry.
    expect(panel.getByLabelText("Ask Agora")).toBeEnabled();
  },
};

export const Listening: Story = {
  parameters: {
    apiRoutes: { "GET /api/me": voiceMe },
    setup: open({ phase: "listening" }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    expect(panel.getByTestId("jarvis-status")).toHaveTextContent("Listening — just talk");
    const mic = panel.getByRole("button", { name: "Microphone" });
    expect(mic).toHaveAttribute("aria-pressed", "true");
    expect(mic).toHaveClass("is-live");
    expect(mic.title).toMatch(/^Mic on/);
    expect(panel.getByPlaceholderText("Or type…")).toBeVisible();
  },
};

export const Speaking: Story = {
  parameters: {
    apiRoutes: { "GET /api/me": voiceMe },
    setup: open({
      phase: "speaking", conversationId: "jc_story", transcript: "what agents are online",
      log: [said("user", "what agents are online"), said("assistant", answer, "story-answer")],
      spoken: { id: "story-answer", start: 0, end: answer.indexOf(".") + 1 },
    }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const log = within(panel.getByTestId("jarvis-log"));
    expect(log.getByText("Two agents are online: Claude and Codex.")).toHaveClass("jv-spoken");
    const speaker = panel.getByRole("button", { name: "Speaker" });
    expect(speaker).toHaveClass("is-live");
    await userEvent.click(speaker);
    expect(useJarvis.getState().speakerOff).toBe(true);
    expect(localStorage.getItem("agora_jarvis_speaker_off")).toBe("1");
    expect(speaker.title).toBe("Speaker off — replies are text only");
  },
};

export const Muted: Story = {
  parameters: {
    apiRoutes: { "GET /api/me": voiceMe },
    setup: open({ micMuted: true }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const mic = panel.getByRole("button", { name: "Microphone" });
    expect(mic).toHaveAttribute("aria-pressed", "false");
    expect(mic).toHaveClass("is-off");
    expect(mic.title).toBe("Mic off — type instead");
    expect(panel.getByText(/^Try “catch me up”/)).toBeVisible();
    await userEvent.click(mic);
    expect(useJarvis.getState().micMuted).toBe(false);
  },
};

export const VoiceUnavailable: Story = {
  name: "Voice unavailable",
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const mic = panel.getByRole("button", { name: "Microphone" });
    const speaker = panel.getByRole("button", { name: "Speaker" });
    expect(mic).toHaveClass("is-unavailable");
    expect(mic).toHaveAttribute("aria-disabled", "true");
    expect(mic.title).toMatch(/Voice input isn't set up/);
    expect(speaker.title).toMatch(/Spoken replies aren't set up/);
    await userEvent.click(mic);
    expect(useJarvis.getState().micMuted).toBe(false);
    expect(panel.getByLabelText("Ask Agora")).toBeEnabled();
  },
};

