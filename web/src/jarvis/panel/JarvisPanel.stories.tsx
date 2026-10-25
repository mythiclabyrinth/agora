import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { JarvisCard, Schedule } from "@agora/core";
import { fixtureMe, fixtureRootMessage } from "@agora/core/testing/fixtures";
import { useJarvis, type JarvisCardEntry, type JarvisLogEntry, type JarvisState } from "../../state/jarvis";
import { useUiState } from "../../state/ui";
import { JarvisPanel, jarvisLevel } from "./JarvisPanel";

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
  revision: 1,
};

const entry = (id: string, card: JarvisCard): JarvisCardEntry => ({
  id, card, status: "draft_id" in card ? "pending" : undefined,
});

function open(state: Partial<JarvisState>) {
  return () => {
    parkMic();
    useJarvis.setState({ enabled: true, isOpen: true, phase: "armed", wake: "listening", ...state });
  };
}

const sendDraft = fn(() => ({ ok: true, message: { ...fixtureRootMessage, id: 9001 }, already_sent: false }));
// The card saves an edit (new revision) before Send quotes it.
const saveDraft = fn((body: unknown) => {
  const text = (body as { text: string }).text;
  return { ok: true, draft_id: "jd_story", revision: 2, text, final_text: text };
});

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
    expect(card.getByRole("button", { name: "Needs you 1" })).toBeVisible();
    expect(card.getByText("4 new")).toBeVisible();
    await userEvent.click(card.getByRole("button", { name: "Open thread: #storybook, Release checklist, needs your attention" }));
    expect(useUiState.getState().sel.c).toBe("general");
    expect(useUiState.getState().threadRoot).toBe(101);
  },
};

export const Draft: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": jarvisMe,
      "PUT /api/jarvis/drafts/jd_story": saveDraft,
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
    // The edit is saved first, then Send quotes the revision it produced.
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 })));
    expect(saveDraft).toHaveBeenCalledWith({ text: "@claude please rerun the deploy once the linter passes. Thanks!", revision: 1 });
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

export const StopSpeaking: Story = {
  parameters: Speaking.parameters,
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const stop = panel.getByRole("button", { name: "Stop speaking" });
    expect(stop.title).toBe("Stop speaking — the text keeps coming");
    await userEvent.click(stop);
    expect(useJarvis.getState().phase).not.toBe("speaking");
    // One-off: the Sound setting is untouched, and the button goes away.
    expect(useJarvis.getState().speakerOff).toBe(false);
    expect(panel.queryByRole("button", { name: "Stop speaking" })).toBeNull();
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
    expect(panel.getByText("Conversation muted · wake word stays on")).toBeVisible();
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


// Richer fixtures exercise the real layout pressure: many results, a long
// transcript and live speech. These doubles do not access the microphone.
const briefing: JarvisCard = {
  kind: "digest",
  items: [
    { channel_id: "release", channel_name: "release", group_id: "launch", group_name: "Launch", thread_id: 201, thread_title: "Friday launch", gist: "Staging is green. Priya needs your go-ahead for the 25% rollout.", needs_you: true, unread: 6, mentions: 1 },
    { channel_id: "design", channel_name: "design", group_id: "launch", group_name: "Launch", thread_id: 202, thread_title: "A calmer onboarding", gist: "The new direction is ready. Lena is waiting for your feedback on the first-run experience.", needs_you: true, unread: 4, mentions: 1 },
    { channel_id: "infra", channel_name: "infra", group_id: "platform", group_name: "Platform", thread_id: null, gist: "The cache fix is live. Search latency is back under 200 ms.", needs_you: false, unread: 8, mentions: 0 },
    { channel_id: "general", channel_name: "general", group_id: "launch", group_name: "Launch", thread_id: null, gist: "The team shared a recap from this morning's planning session.", needs_you: false, unread: 3, mentions: 0 },
    { channel_id: "watercooler", channel_name: "watercooler", group_id: "random", group_name: "Random", thread_id: null, gist: "A few good reads for the weekend, collected by the team.", needs_you: false, unread: 2, mentions: 0 },
  ],
};
const briefingAnswer = "You're almost caught up. Two things need you: the launch go-ahead and feedback on the new onboarding. Everything else is moving along.";
const briefingState: Partial<JarvisState> = {
  phase: "armed", conversationId: "jc_preview",
  log: [said("user", "Catch me up on what I missed."), said("assistant", briefingAnswer)],
  cards: [entry("briefing", briefing)],
};

export const Welcome: Story = {
  parameters: { apiRoutes: { "GET /api/me": voiceMe }, setup: open({}), appearance: "dark" },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    await userEvent.click(panel.getByRole("button", { name: "Catch me up" }));
    expect(panel.getByLabelText("Ask Agora")).toHaveValue("Catch me up on my unread conversations");
    expect(panel.getByRole("button", { name: "Ask" })).toBeEnabled();
  },
};

export const Briefing: Story = {
  parameters: { apiRoutes: { "GET /api/me": voiceMe }, appearance: "dark", setup: open(briefingState) },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const card = within(panel.getByTestId("jarvis-digest"));
    expect(card.getAllByRole("listitem")).toHaveLength(2);
    const releaseRow = card.getByRole("button", { name: "Open thread: #release, Friday launch, needs your attention" });
    await userEvent.click(card.getByRole("button", { name: "Needs you 2" }));
    expect(card.getByRole("button", { name: "Open thread: #release, Friday launch, needs your attention" })).toBe(releaseRow);
    expect(card.getAllByRole("listitem")).toHaveLength(2);
    expect(card.queryByText("#infra")).toBeNull();
    await userEvent.click(card.getByRole("button", { name: "All activity" }));
    await userEvent.click(card.getByRole("button", { name: "Show 3 more conversations" }));
    expect(card.getAllByRole("listitem")).toHaveLength(5);
    await userEvent.click(card.getByRole("button", { name: "Show less" }));
    expect(card.getAllByRole("listitem")).toHaveLength(2);
  },
};

export const BriefingLight: Story = {
  parameters: { ...Briefing.parameters, appearance: "light" },
};

export const SpeakingPreview: Story = {
  parameters: { ...Speaking.parameters, appearance: "dark" },
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement).findByRole("dialog", { name: "Agora assistant" });
    const halo = panel.querySelector(".jv-aura")!;
    const before = getComputedStyle(halo).transform;
    const source = jarvisLevel.source;
    try {
      jarvisLevel.source = () => 0.8;
      await waitFor(() => expect(getComputedStyle(halo).transform).not.toBe(before));
    } finally { jarvisLevel.source = source; }
  },
};

export const DraftPreview: Story = {
  parameters: { ...Draft.parameters, appearance: "light" },
};

export const ConversationHistory: Story = {
  parameters: {
    setup: open({ ...briefingState, log: [
      said("user", "How did the release go?", "old-question"),
      said("assistant", "The rollout went smoothly. No new incidents.", "old-answer"),
      ...briefingState.log!,
    ] }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    expect(panel.getByText("The rollout went smoothly. No new incidents.")).not.toBeVisible();
    await userEvent.click(panel.getByText("Earlier in this conversation"));
    expect(panel.getByText("The rollout went smoothly. No new incidents.")).toBeVisible();
    expect(panel.getByText(briefingAnswer)).toBeVisible();
  },
};

export const LongAnswer: Story = {
  parameters: {
    setup: open({ ...briefingState, log: [said("user", "Give me the full picture."), said("assistant", Array.from({ length: 12 }, (_, i) => `${i + 1}. The release is moving forward. Priya has confirmed the staging checks and is waiting for the rollout decision.`).join("\n\n"))] }),
  },
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement).findByRole("dialog", { name: "Agora assistant" });
    const rect = panel.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    const input = within(panel).getByLabelText("Ask Agora").getBoundingClientRect();
    expect(input.bottom).toBeLessThanOrEqual(rect.bottom);
    expect(input.height).toBeGreaterThan(20);
    const log = within(panel).getByTestId("jarvis-log");
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
  },
};

export const EarlierResults: Story = {
  parameters: {
    setup: open({ ...briefingState, cards: [entry("new-result", briefing), entry("pending-draft", draft), entry("old-result", digest)] }),
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    expect(panel.getByTestId("jarvis-draft")).toBeVisible();
    const briefings = panel.getAllByTestId("jarvis-digest");
    expect(briefings[0]).toBeVisible();
    expect(briefings[1]).not.toBeVisible();
    await userEvent.click(panel.getByText("Earlier results"));
    expect(briefings[1]).toBeVisible();
    await userEvent.click(within(panel.getByTestId("jarvis-draft")).getByRole("button", { name: "Edit" }));
    expect(panel.getByLabelText("Draft message")).not.toHaveAttribute("readonly");
  },
};

const discardDraft = fn(() => ({ ok: true, cancelled: true }));

export const DiscardDraft: Story = {
  parameters: {
    ...Draft.parameters,
    apiRoutes: { "GET /api/me": jarvisMe, "DELETE /api/jarvis/drafts/jd_story": discardDraft },
  },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    const card = panel.getByTestId("jarvis-draft");
    expect(card.closest(".jv-cards")).toHaveAttribute("aria-live", "polite");
    expect(within(card).getByText(/Expires in/)).toHaveAttribute("aria-live", "off");
    expect(panel.queryByRole("button", { name: "Dismiss card" })).toBeNull();
    const discard = within(card).getByRole("button", { name: "Discard draft" });
    discard.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(discardDraft).toHaveBeenCalled());
    expect(panel.queryByTestId("jarvis-draft")).toBeNull();
    expect(useJarvis.getState().cards).toHaveLength(0);
    expect(panel.getByLabelText("Ask Agora")).toHaveFocus();
  },
};

export const DraftExpiring: Story = {
  parameters: {
    appearance: "dark",
    setup: () => open({ ...briefingState, cards: [{ ...entry("expiring", draft), expiresAt: Date.now() + 19000 }] })(),
  },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-draft"));
    expect(card.getByText(/Expires in/)).toHaveClass("is-soon");
    expect(card.getByRole("button", { name: "Send" })).toBeEnabled();
    await userEvent.click(card.getByRole("button", { name: "Edit" }));
    expect(card.getByLabelText("Draft message")).toHaveFocus();
    expect(card.getByLabelText("Draft message")).not.toHaveAttribute("readonly");
  },
};

export const DraftExpired: Story = {
  parameters: {
    setup: () => open({ ...briefingState, cards: [{ ...entry("expired", draft), expiresAt: Date.now() - 1000 }] })(),
  },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-draft"));
    await expect(card.findByText("Expired")).resolves.toBeVisible();
    expect(card.queryByRole("button", { name: "Send" })).toBeNull();
    expect(card.getByText("Nothing was sent. Ask Agora for a fresh draft.")).toBeVisible();
  },
};

export const DraftSending: Story = {
  parameters: { setup: open({ ...briefingState, cards: [{ ...entry("sending", draft), status: "sending" }] }) },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-draft"));
    expect(card.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(card.getByRole("button", { name: "Discard draft" })).toBeDisabled();
    expect(card.getByRole("button", { name: "Edit" })).toBeDisabled();
  },
};

export const DraftSent: Story = {
  parameters: { appearance: "light", setup: open({ ...briefingState, cards: [{ ...entry("sent", draft), status: "sent" }] }) },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-draft"));
    expect(card.getByText("Sent")).toBeVisible();
    expect(card.queryByRole("button", { name: "Send" })).toBeNull();
    await userEvent.click(card.getByRole("button", { name: "Open conversation" }));
    expect(useUiState.getState().sel.c).toBe("general");
  },
};

const matches: JarvisCard = {
  kind: "messages", title: "The release decision",
  messages: [
    { id: 401, channel_id: "general", channel_name: "release", group_id: "product", group_name: "Product", thread_id: 101, author: "Priya", text: "Staging checks are green. Tom, can you approve the 25% rollout before we move ahead?", ts: 0 },
    { id: 402, channel_id: "general", channel_name: "release", group_id: "product", group_name: "Product", thread_id: 101, author: "Marco", text: "The rollback is ready. I will watch error rates during the first hour.", ts: 0 },
  ],
};

export const SearchResults: Story = {
  parameters: { appearance: "dark", setup: open({ ...briefingState, cards: [entry("matches", matches)] }) },
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("dialog", { name: "Agora assistant" }));
    expect(panel.getByRole("heading", { name: "The release decision" })).toBeVisible();
    const hit = panel.getByRole("button", { name: /Priya.*Staging checks/ });
    hit.focus();
    await userEvent.keyboard("{Enter}");
    expect(useUiState.getState().threadRoot).toBe(101);
  },
};

export const MixedWorkspaceResults: Story = {
  parameters: { appearance: "dark", setup: open({ ...briefingState, cards: [entry("briefing", briefing), entry("draft", draft), entry("search", matches)] }) },
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement).findByRole("dialog", { name: "Agora assistant" });
    const panel = within(dialog);
    expect(panel.getByText("2 results")).toBeVisible();
    expect(dialog.querySelectorAll('[aria-live="polite"].jv-cards')).toHaveLength(1);
    const earlier = dialog.querySelector(".jv-previous-results .jv-cards");
    expect(earlier).not.toHaveAttribute("aria-live");
    await userEvent.click(panel.getByText("Earlier results"));
    expect(panel.getByRole("heading", { name: "The release decision" })).toBeVisible();
  },
};

export const EmptyBriefing: Story = {
  parameters: { setup: open({ ...briefingState, cards: [entry("empty", { kind: "digest", items: [] })] }) },
};

const undoDraft = fn(() => ({ ok: true }));
export const DraftUndo: Story = {
  parameters: {
    ...Draft.parameters,
    apiRoutes: {
      "GET /api/me": jarvisMe,
      "POST /api/jarvis/drafts/jd_story/send": sendDraft,
      "DELETE /api/channels/general/messages/9001": undoDraft,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByTestId("jarvis-draft"));
    await userEvent.click(card.getByRole("button", { name: "Send" }));
    await expect(card.findByText("Sent")).resolves.toBeVisible();
    await userEvent.click(await canvas.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undoDraft).toHaveBeenCalled());
    expect(card.getByText("This draft is closed. It cannot be sent again.")).toBeVisible();
    expect(card.queryByRole("button", { name: "Send" })).toBeNull();
  },
};

// ---------------------------------------------------------------- schedules

const DAY = 86_400;
const monday9 = 1793005200; // 2026-10-26 09:00 UTC (a Monday)
const scheduleDraft: JarvisCard = {
  kind: "schedule_draft", draft_id: "jd_sched", revision: 1,
  channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
  thread_id: null, destination: "#storybook",
  text: "Post the standup summary and flag anything blocked.",
  final_text: "@claude @codex Post the standup summary and flag anything blocked.",
  mentions: [
    { kind: "agent", id: "claude", name: "Claude", handle: "claude" },
    { kind: "agent", id: "codex", name: "Codex", handle: "codex" },
  ],
  schedule: { kind: "cron", expr: "0 13 * * 1-5" }, run_at: monday9 + 4 * 3600,
  next_runs: [monday9 + 4 * 3600, monday9 + DAY + 4 * 3600, monday9 + 2 * DAY + 4 * 3600],
  dst_note: "Stored in UTC: when daylight saving changes, the local time this posts at shifts by an hour.",
  expires_in: 120,
};

const loop: Schedule = {
  id: "sch_loop", owner: "ana", owner_name: "Ana", channel_id: "general", channel_name: "storybook", channel_kind: "channel",
  group_id: "product", thread_id: null, thread_title: null, text: "@claude LOOP dependabot audit · run 4",
  schedule: { kind: "interval", seconds: 6 * 3600 }, run_at: monday9, next_runs: [monday9, monday9 + 6 * 3600, monday9 + 12 * 3600],
  status: "active", last_run_at: monday9 - 6 * 3600, last_error: null, created_at: monday9 - 7 * DAY, updated_at: monday9 - 6 * 3600,
  created_by: "ana", updated_by: "ana", via_agent: null, is_owner: true, can_manage: true, channel_access: true,
};

const scheduleChange: JarvisCard = {
  kind: "schedule_change", draft_id: "jd_change", revision: 1, action: "retime",
  summary: "Change the schedule in #storybook to run on weekdays at 13:00 UTC", destination: "#storybook",
  schedule: loop,
  after: { status: "active", schedule: { kind: "cron", expr: "0 13 * * 1-5" }, run_at: monday9 + 4 * 3600,
    next_runs: [monday9 + 4 * 3600, monday9 + DAY + 4 * 3600, monday9 + 2 * DAY + 4 * 3600] },
  dst_note: null, expires_in: 120,
};

const schedulesList: JarvisCard = {
  kind: "schedules", total: 23, offset: 0, has_more: true, truncated: false,
  items: [
    loop,
    { ...loop, id: "sch_2", text: "@codex weekly release notes draft", schedule: { kind: "cron", expr: "0 16 * * 5" }, status: "paused", next_runs: [monday9 + 4 * DAY + 7 * 3600] },
    { ...loop, id: "sch_3", text: "Remind #storybook about the retro", schedule: { kind: "once", at: monday9 - 3 * DAY }, status: "done", next_runs: [], last_error: "Channel was archived" },
  ],
};

const confirmSchedule = fn(() => ({ ok: true, kind: "schedule", action: "create", schedule: { ...loop, id: "sch_new", schedule: { kind: "cron", expr: "0 13 * * 1-5" }, next_runs: [monday9 + 4 * 3600, monday9 + DAY + 4 * 3600, monday9 + 2 * DAY + 4 * 3600], text: "@claude @codex Post the standup summary and flag anything blocked." }, already_sent: false }));

export const ScheduleDraft: Story = {
  parameters: {
    apiRoutes: { "GET /api/me": jarvisMe, "POST /api/jarvis/drafts/jd_sched/send": confirmSchedule },
    setup: open({
      transcript: "every weekday at 9 have Claude and Codex post the standup summary in #storybook", conversationId: "jc_story",
      caption: "Scheduled for #storybook, on the rule “0 13 * * 1-5” (UTC), first at 2026-10-26 09:00 your time. Schedule it?",
      log: [
        said("user", "every weekday at 9 have Claude and Codex post the standup summary in #storybook"),
        said("assistant", "Scheduled for #storybook, on the rule “0 13 * * 1-5” (UTC), first at 2026-10-26 09:00 your time: “@claude @codex Post the standup summary and flag anything blocked.” Schedule it?"),
      ],
      cards: [entry("jc-sched", scheduleDraft)],
    }),
  },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-schedule-draft"));
    expect(card.getByText("@claude")).toBeVisible();
    expect(card.getByText("@codex")).toBeVisible();
    expect(card.getByRole("note")).toHaveTextContent("daylight saving");
    expect(card.getAllByText(/UTC$/).length).toBeGreaterThan(0);
    await userEvent.click(card.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(confirmSchedule).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 })));
    await expect(card.findByText("Scheduled")).resolves.toBeVisible();
  },
};

export const ScheduleChange: Story = {
  parameters: {
    setup: open({
      ...briefingState,
      log: [said("user", "move my dependabot loop to weekdays at 9"), said("assistant", "Change the schedule in #storybook to run on weekdays at 13:00 UTC. Apply this change?")],
      cards: [entry("jc-change", scheduleChange)],
    }),
  },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-schedule-change"));
    expect(card.getByText("Now")).toBeVisible();
    expect(card.getByText("After")).toBeVisible();
    expect(card.getByRole("button", { name: "Change time" })).toBeEnabled();
    expect(card.queryByRole("button", { name: "Edit" })).toBeNull();
  },
};

export const SchedulesList: Story = {
  parameters: { setup: open({ ...briefingState, cards: [entry("jc-list", schedulesList)] }) },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId("jarvis-schedules"));
    expect(card.getByText(/1–3 of 23/)).toBeVisible();
    expect(card.getByText(/next page/)).toBeVisible();
    expect(card.getByText("Channel was archived")).toBeVisible();
  },
};
