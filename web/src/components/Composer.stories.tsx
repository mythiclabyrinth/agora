import { expectOpaqueSurface } from "../stories/opaqueSurfaces";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import { Composer, useAddressing, useDrafts } from "./Composer";
import { me, message } from "../stories/fixtures/data";
import { useAddressed, useAttachmentDrafts } from "@agora/core";
import { fixtureTemplates } from "@agora/core/testing/fixtures";
import { useVoiceRec } from "../state/voiceRec";
import { appendDraft } from "../state/drafts";
import { useRequireAgent } from "../state/requireAgent";

const agents = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];

const candidates = [
  { type: "agent" as const, id: "codex", name: "Codex", slug: "codex" },
  { type: "agent" as const, id: "claude", name: "Claude", slug: "claude" },
  { type: "user" as const, id: "alice", name: "Alice", slug: "alice" },
];

const sendMessage = fn((body: unknown) => ({
  ...message,
  text: (body as { text: string }).text,
}));

const meta = {
  title: "Web/Composer/Message composer",
  component: Composer,
  decorators: [(Story) => (
    <div
      className="agora-main"
      style={{ width: "min(760px, 100%)", minHeight: 320, justifyContent: "flex-end" }}
    >
      <Story />
    </div>
  )],
  args: {
    channelId: "general",
    channelName: "general",
    groupId: "product",
    threadId: null,
    agents,
    candidates,
    voiceOK: false,
    replyInThread: false,
    onSetReplyInThread: fn(),
  },
  parameters: {
    apiRoutes: {
      "GET /api/me": me,
      "GET /api/agents": { agents },
      "GET /api/groups/product/templates": { templates: [] },
      "POST /api/channels/general/messages": sendMessage,
    },
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const EscapeBlursWhileOtherComposerRecords: Story = {
  parameters: {
    setup: () => useVoiceRec.setState({ recordingKey: "t:42", startedAt: Date.now(), busyKey: null }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole("textbox");
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    expect(input).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    useVoiceRec.setState({ recordingKey: null, startedAt: 0, busyKey: null });
  },
};

export const VoiceTranscriptAppend: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    await userEvent.type(input, "Typed while transcribing");
    appendDraft("general", " voice result ");
    await waitFor(() => expect(input).toHaveValue("Typed while transcribing voice result"));
  },
};

function InitiallyHiddenComposer(props: React.ComponentProps<typeof Composer>) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <button onClick={() => setVisible(true)}>Show composer</button>
      <div style={{ display: visible ? "block" : "none" }}>
        <Composer {...props} />
      </div>
    </>
  );
}

export const RestoresHeightAfterHiddenMount: Story = {
  parameters: {
    setup: () => useDrafts.getState().setDraft("general", "Hidden draft line one\nHidden draft line two\nHidden draft line three"),
  },
  render: args => <InitiallyHiddenComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
    expect(input.getBoundingClientRect().height).toBe(0);
    await userEvent.click(canvas.getByRole("button", { name: "Show composer" }));
    await waitFor(() => expect(input.getBoundingClientRect().height).toBeGreaterThan(40));
  },
};

export const HeightResetsAfterSend: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Message #general") as HTMLTextAreaElement;
    await waitFor(() => expect(input.style.height).not.toBe(""));
    const baseline = input.getBoundingClientRect().height;

    await userEvent.type(input, "A long message that wraps across several lines in the composer. ".repeat(12));
    await waitFor(() => expect(input.getBoundingClientRect().height).toBeGreaterThan(baseline));
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(input).toHaveValue("");
      expect(input.getBoundingClientRect().height).toBe(baseline);
    });
  },
};

const withTemplateRoutes = {
  "GET /api/me": me,
  "GET /api/agents": { agents },
  "GET /api/groups/product/templates": { templates: fixtureTemplates },
  "POST /api/channels/general/messages": sendMessage,
};

/* Keep the floating picker visible for visual review. The computed-color
   assertion ensures its surface stays opaque instead of inheriting the
   translucent in-flow panel token. */
export const TemplatesPickerOpen: Story = {
  parameters: { apiRoutes: withTemplateRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTitle("Message templates"));
    const picker = await canvas.findByText("Daily standup");
    const popover = picker.closest(".ago-template-pop");
    expect(popover).not.toBeNull();
    expectOpaqueSurface(".ago-template-pop");
  },
};

/* Swaps channelId on a live Composer the way ChannelPane does — no remount,
   so the draftKey effect (not a fresh mount) is what clears the caret. */
function SwitchableComposer(props: React.ComponentProps<typeof Composer>) {
  const [channel, setChannel] = useState("general");
  return (
    <>
      <button data-testid="switch-channel" onClick={() => setChannel("random")}>
        switch channel
      </button>
      <Composer {...props} channelId={channel} channelName={channel} />
    </>
  );
}

/* A chosen template lands at the caret, leaving the typed draft in place —
   and a caret from the previous conversation never decides the insert point. */
export const WithTemplates: Story = {
  parameters: { apiRoutes: withTemplateRoutes },
  render: args => <SwitchableComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
    await userEvent.type(input, "Draft: ");
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    await userEvent.click(canvas.getByTitle("Message templates"));
    await userEvent.click(await canvas.findByText("Daily standup"));
    await waitFor(() => expect(input).toHaveValue(`Dra${fixtureTemplates[0].text}ft: `));

    // Same textarea, new conversation: the stale caret at 3 must not splice.
    useDrafts.getState().setDraft("random", "Second draft");
    await userEvent.click(canvas.getByTestId("switch-channel"));
    const next = await canvas.findByPlaceholderText("Message #random") as HTMLTextAreaElement;
    await userEvent.click(canvas.getByTitle("Message templates"));
    await userEvent.click(await canvas.findByText("Daily standup"));
    await waitFor(() => expect(next).toHaveValue(`Second draft${fixtureTemplates[0].text}`));
  },
};

let releaseGeneralUpload: ((value: unknown) => void) | undefined;
const pendingGeneralUpload = fn(() => new Promise(resolve => { releaseGeneralUpload = resolve; }));
const sendRandom = fn((body: unknown) => ({ ...message, text: (body as { text: string }).text }));

export const SendAfterSwitchWhileUploadPending: Story = {
  parameters: {
    setup: () => {
      stage([new File(["attachment"], "note.txt", { type: "text/plain" })]);
      pendingGeneralUpload.mockClear();
      sendRandom.mockClear();
    },
    apiRoutes: {
      ...withTemplateRoutes,
      "UPLOAD /api/channels/general/messages/upload": pendingGeneralUpload,
      "POST /api/channels/random/messages": sendRandom,
    },
  },
  render: args => <SwitchableComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Message #general"), "first");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(pendingGeneralUpload).toHaveBeenCalledTimes(1));
    await userEvent.click(canvas.getByTestId("switch-channel"));
    await userEvent.type(await canvas.findByPlaceholderText("Message #random"), "second");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendRandom).toHaveBeenCalledTimes(1));
    releaseGeneralUpload?.(message);
  },
};

let releaseFirstPlainSend: ((value: unknown) => void) | undefined;
let plainSendCalls = 0;
const pendingPlainSend = fn((body: unknown) => {
  plainSendCalls++;
  const response = { ...message, text: (body as { text: string }).text };
  return plainSendCalls === 1
    ? new Promise(resolve => { releaseFirstPlainSend = resolve; })
    : response;
});

export const TwoSendsInSameChannel: Story = {
  parameters: {
    setup: () => { plainSendCalls = 0; pendingPlainSend.mockClear(); },
    apiRoutes: { ...withTemplateRoutes, "POST /api/channels/general/messages": pendingPlainSend },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    await userEvent.type(input, "ok{Enter}");
    await waitFor(() => expect(pendingPlainSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input).toHaveValue(""));
    await userEvent.keyboard("{Enter}");
    expect(pendingPlainSend).toHaveBeenCalledTimes(1);
    await userEvent.type(input, "thanks{Enter}");
    await waitFor(() => expect(pendingPlainSend).toHaveBeenCalledTimes(2));
    expect(pendingPlainSend.mock.calls.map(([body]) => (body as { text: string }).text)).toEqual(["ok", "thanks"]);
    releaseFirstPlainSend?.(message);
  },
};

function ReplyToggleComposer(props: React.ComponentProps<typeof Composer>) {
  const [replyInThread, setReplyInThread] = useState(false);
  return <Composer {...props} replyInThread={replyInThread} onSetReplyInThread={setReplyInThread} />;
}

export const ReplyToggleResetsBeforeSecondSend: Story = {
  parameters: {
    setup: () => { plainSendCalls = 0; pendingPlainSend.mockClear(); },
    apiRoutes: { ...withTemplateRoutes, "POST /api/channels/general/messages": pendingPlainSend },
  },
  render: args => <ReplyToggleComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveClass("active"));
    await userEvent.type(input, "q1{Enter}");
    await waitFor(() => expect(pendingPlainSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).not.toHaveClass("active"));
    await userEvent.type(input, "q2{Enter}");
    await waitFor(() => expect(pendingPlainSend).toHaveBeenCalledTimes(2));
    expect(pendingPlainSend.mock.calls[0][0]).toMatchObject({ text: "q1", reply_in_thread: true });
    expect(pendingPlainSend.mock.calls[1][0]).not.toHaveProperty("reply_in_thread");
    releaseFirstPlainSend?.(message);
  },
};

export const ReplyToggleResetsAfterPendingSend: Story = {
  parameters: {
    setup: () => { plainSendCalls = 0; pendingPlainSend.mockClear(); },
    apiRoutes: { ...withTemplateRoutes, "POST /api/channels/general/messages": pendingPlainSend },
  },
  render: args => <ReplyToggleComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await userEvent.type(input, "q1{Enter}");
    await waitFor(() => expect(pendingPlainSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).not.toHaveClass("active"));
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveClass("active"));
    releaseFirstPlainSend?.(message);
    await waitFor(() => expect(useDrafts.getState().metaByConvo.general.reply_in_thread).toBe(false));
    expect(toggle).not.toHaveClass("active");
  },
};

const failedReplySend = fn(async () => { throw new Error("offline"); });

export const FailedReplySendRestoresToggle: Story = {
  parameters: {
    setup: () => failedReplySend.mockClear(),
    apiRoutes: { ...withTemplateRoutes, "POST /api/channels/general/messages": failedReplySend },
  },
  render: args => <ReplyToggleComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await userEvent.type(input, "hello{Enter}");
    await waitFor(() => expect(failedReplySend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toHaveClass("active"));
    await expect(input).toHaveValue("hello");
    expect(useDrafts.getState().metaByConvo.general.reply_in_thread).toBe(true);
  },
};

let rejectSwitchedSend: ((reason: Error) => void) | undefined;
const failedAfterSwitch = fn(() => new Promise((_resolve, reject) => { rejectSwitchedSend = reject; }));
function SwitchableReplyComposer(props: React.ComponentProps<typeof Composer>) {
  const [channel, setChannel] = useState("general");
  const [replyInThread, setReplyInThread] = useState(false);
  return <><button data-testid="switch-channel" onClick={() => setChannel("random")}>switch channel</button>
    <Composer {...props} channelId={channel} channelName={channel}
      replyInThread={replyInThread} onSetReplyInThread={setReplyInThread} /></>;
}

export const FailedReplySendAfterChannelSwitch: Story = {
  parameters: {
    setup: () => failedAfterSwitch.mockClear(),
    apiRoutes: { ...withTemplateRoutes, "POST /api/channels/general/messages": failedAfterSwitch },
  },
  render: args => <SwitchableReplyComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await userEvent.type(canvas.getByPlaceholderText("Message #general"), "hello{Enter}");
    await waitFor(() => expect(failedAfterSwitch).toHaveBeenCalledTimes(1));
    await userEvent.click(canvas.getByTestId("switch-channel"));
    await waitFor(() => expect(toggle).not.toHaveClass("active"));
    rejectSwitchedSend?.(new Error("offline"));
    await waitFor(() => expect(useDrafts.getState().byConvo.general).toBe("hello"));
    expect(toggle).not.toHaveClass("active");
  },
};

export const ReplyToggleStaysOnWhenTypingAfterSwitch: Story = {
  render: args => <SwitchableReplyComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("switch-channel"));
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveClass("active"));
    await userEvent.type(canvas.getByPlaceholderText("Message #random"), "keep this setting");
    expect(toggle).toHaveClass("active");
  },
};

let rejectCaptionUpload: ((reason: Error) => void) | undefined;
const failingCaptionUpload = fn(() => new Promise((_resolve, reject) => { rejectCaptionUpload = reject; }));

export const FailedUploadKeepsCaption: Story = {
  parameters: {
    setup: () => {
      stage([new File(["image"], "photo.png", { type: "image/png" })]);
      failingCaptionUpload.mockClear();
    },
    apiRoutes: { ...withTemplateRoutes, "UPLOAD /api/channels/general/messages/upload": failingCaptionUpload },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    await userEvent.type(input, "look at this");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(failingCaptionUpload).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "final cut" } });
    rejectCaptionUpload?.(new Error("upload cancelled"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await waitFor(() => expect(input).toHaveValue("final cut"));
  },
};

let releaseReplyUpload: ((value: unknown) => void) | undefined;
const pendingReplyUpload = fn(() => new Promise(resolve => { releaseReplyUpload = resolve; }));

export const ReplyToggleResetsAfterUploadWithTyping: Story = {
  parameters: {
    setup: () => {
      stage([new File(["image"], "photo.png", { type: "image/png" })]);
      pendingReplyUpload.mockClear();
    },
    apiRoutes: { ...withTemplateRoutes, "UPLOAD /api/channels/general/messages/upload": pendingReplyUpload },
  },
  render: args => <ReplyToggleComposer {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    const toggle = canvas.getByTitle("Agents answer this message in a thread under it");
    await userEvent.click(toggle);
    await userEvent.type(input, "see attached");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(pendingReplyUpload).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "follow-up" } });
    releaseReplyUpload?.(message);
    await waitFor(() => expect(toggle).not.toHaveClass("active"));
    await waitFor(() => expect(useDrafts.getState().metaByConvo.general.reply_in_thread).toBe(false));
    expect(input).toHaveValue("follow-up");
  },
};

/* The manage dialog: deleting is a two-step armed click, like every other
   destructive action in the web UI. */
export const ManageTemplates: Story = {
  parameters: { apiRoutes: withTemplateRoutes },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox"));
    await userEvent.click(canvas.getByTitle("Message templates"));
    await userEvent.click(await canvas.findByText("Manage"));
    const dialog = within(await canvas.findByRole("dialog"));
    await dialog.findByText(fixtureTemplates[0].label);
    await userEvent.click(dialog.getAllByText("Delete")[0]);
    await waitFor(() => expect(dialog.getByText("Sure?")).toBeInTheDocument());
  },
};

const previewSvg = new File([
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">'
  + '<rect width="480" height="320" fill="#312e81"/>'
  + '<circle cx="150" cy="145" r="70" fill="#8b7cff"/>'
  + '<text x="250" y="175" fill="white" font-size="28">Composer preview</text>'
  + "</svg>",
], "release-dashboard.svg", { type: "image/svg+xml" });

function stage(files: File[], status: "ready" | "preparing" = "ready") {
  useAttachmentDrafts.getState().stage("c:general", files, status, 5);
}

export const ImageAndDocuments: Story = {
  parameters: {
    setup: () => stage([
      previewSvg,
      new File(["%PDF"], "release-plan.pdf", { type: "application/pdf" }),
      new File(["review"], `${"responsive-attachment-review-".repeat(3)}.docx`, {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ]),
  },
};

export const ImagePreview: Story = {
  parameters: { setup: () => stage([previewSvg]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Preview release-dashboard.svg" }));
    const body = within(document.body);
    await expect(body.findByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(body.queryByRole("dialog", {
        name: "Image preview: release-dashboard.svg",
      })).not.toBeInTheDocument();
    });
  },
};

export const PreparingAndFailed: Story = {
  parameters: {
    setup: () => {
      stage([new File(["pending"], "dragged-screenshot.png", { type: "image/png" })], "preparing");
      const failed = useAttachmentDrafts.getState().stage(
        "c:general",
        [new File(["broken"], "unreadable.pdf", { type: "application/pdf" })],
        "preparing",
        5,
      ).accepted[0];
      useAttachmentDrafts.getState().fail("c:general", failed.id, "Could not read unreadable.pdf");
    },
  },
};

export const SendingImage: Story = {
  parameters: {
    setup: () => {
      const [entry] = useAttachmentDrafts.getState().stage(
        "c:general",
        [previewSvg],
        "ready",
        5,
      ).accepted;
      useAttachmentDrafts.getState().beginSend("c:general", [entry.id], () => {});
    },
  },
};

export const PreviewClosesAfterSend: Story = {
  tags: ["!dev"],
  parameters: { setup: () => stage([previewSvg]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Preview release-dashboard.svg" }));
    const body = within(document.body);
    await expect(body.findByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).resolves.toBeVisible();

    const [entry] = useAttachmentDrafts.getState().byDraft["c:general"];
    useAttachmentDrafts.getState().beginSend("c:general", [entry.id], () => {});
    useAttachmentDrafts.getState().sendSucceeded("c:general", [entry.id]);

    await waitFor(() => {
      expect(body.queryByRole("dialog", {
        name: "Image preview: release-dashboard.svg",
      })).not.toBeInTheDocument();
    });
  },
};

export const DraftWithMention: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Message #general");
    await userEvent.type(input, "Could @co");
    await expect(canvas.findByText("Codex")).resolves.toBeVisible();
  },
};

export const SendAddressedMessage: Story = {
  play: async ({ canvasElement }) => {
    sendMessage.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox"));
    await userEvent.click(await canvas.findByTitle(/Choose which agents you're talking to/));
    await userEvent.click(await canvas.findByText("Codex"));
    const input = await canvas.findByPlaceholderText("Message #general");
    await userEvent.type(input, "Please review");
    await userEvent.keyboard("{Enter}");
    await expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "@codex, Please review",
      thread_id: null,
    }));
    await expect(input).toHaveValue("");
  },
};

export const AddressingPicker: Story = {
  parameters: {
    docs: { description: { story: "Opens the upward “Talk to” menu used to address one or more agents before composing a channel message." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox"));
    await userEvent.click(await canvas.findByTitle(/Choose which agents you're talking to/));
    await expect(canvas.findByText("Talk to")).resolves.toBeVisible();
    await expect(canvas.findByText("Claude")).resolves.toBeVisible();
  },
};

export const KeyboardAddressingPicker: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useAddressing.getState().setPickerKey("c:general");
    const list = await canvas.findByRole("listbox", { name: "Talk to agents" });
    const options = within(list).getAllByRole("option");
    await waitFor(() => expect(options[0]).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}[Space]");
    await expect(options[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("listbox", { name: "Talk to agents" })).toBeNull());
  },
};

export const KeyboardAddressingClear: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useAddressing.getState().setPickerKey("c:general");
    const list = await canvas.findByRole("listbox", { name: "Talk to agents" });
    const first = within(list).getAllByRole("option")[0];
    await userEvent.click(first);
    await expect(first).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(list).getByRole("button", { name: "Clear" }));
    await expect(first).toHaveAttribute("aria-selected", "false");
    await userEvent.click(first);
    const clear = within(list).getByRole("button", { name: "Clear" });
    clear.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "false"));
  },
};

export const KeyboardRequireMention: Story = {
  args: { threadId: 42, onSetReplyInThread: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useRequireAgent.getState().setOn("general:t42", true);
    window.dispatchEvent(new CustomEvent("agora-composer-command", { detail: { id: "thread.requireMention", key: "t:42" } }));
    await expect(canvas.findByTitle("Agents may reply to my messages without an @mention")).resolves.toHaveAttribute("aria-pressed", "false");
  },
};

export const PickerRequireMentionFeedback: Story = {
  args: { threadId: 42, onSetReplyInThread: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useRequireAgent.getState().setOn("general:t42", true);
    useAddressing.getState().setPickerKey("t:42");
    const list = await canvas.findByRole("listbox", { name: "Talk to agents" });
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveFocus());
    await userEvent.keyboard("m");
    await expect(canvas.findByTitle("Agents may reply to my messages without an @mention")).resolves.toHaveAttribute("aria-pressed", "false");
  },
};

export const VoiceSendShortcutKeepsTypedDraft: Story = {
  args: { voiceOK: true },
  parameters: { setup: () => useVoiceRec.setState({ recordingKey: "c:general", startedAt: Date.now(), busyKey: null }) },
  play: async ({ canvasElement }) => {
    sendMessage.mockClear();
    const canvas = within(canvasElement);
    const input = await canvas.findByRole("textbox");
    await userEvent.type(input, "Keep this draft");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", [navigator.platform.includes("Mac") ? "metaKey" : "ctrlKey"]: true });
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(input).toHaveValue("Keep this draft");
  },
};

/* "Talk to" chips plus an in-progress voice note — the surface that must keep
   the addressing prefix in sync with stop-and-send. */
export const AddressingWithVoiceRecording: Story = {
  args: { voiceOK: true },
  parameters: {
    docs: {
      description: {
        story: "Addressing chips (“To”) with the mic in recording state — voice notes must capture the current talk-to prefix on stop-and-send.",
      },
    },
    setup: () => {
      useAddressed.getState().replace("general", ["codex", "claude"]);
      useVoiceRec.setState({
        recordingKey: "c:general",
        startedAt: Date.now() - 12_000,
        busyKey: null,
      });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("To")).resolves.toBeVisible();
    await expect(canvas.findByText("Codex")).resolves.toBeVisible();
    await expect(canvas.findByText("Claude")).resolves.toBeVisible();
    await expect(canvas.findByTitle("Stop and add to message")).resolves.toBeVisible();
    await expect(canvas.findByTitle("Stop and send")).resolves.toBeVisible();
    await waitFor(() => {
      const rects = Array.from(
        canvasElement.querySelectorAll<HTMLElement>(
          ".ago-composer-tools button, .ago-composer-tools summary",
        ),
      ).filter(el => el.offsetParent !== null).map(el => el.getBoundingClientRect());
      // One row: every control overlaps the same horizontal band.
      expect(Math.max(...rects.map(rect => rect.top))).toBeLessThan(
        Math.min(...rects.map(rect => rect.bottom)),
      );
    });
  },
};

export const VoiceRecordingAt360: Story = {
  ...AddressingWithVoiceRecording,
  parameters: {
    ...AddressingWithVoiceRecording.parameters,
    viewport: { defaultViewport: "recordingPhone" },
  },
};

export const VoiceRecordingAt390: Story = {
  ...AddressingWithVoiceRecording,
  parameters: {
    ...AddressingWithVoiceRecording.parameters,
    viewport: { defaultViewport: "phone" },
  },
};

export const VoiceRecordingAt768: Story = {
  ...AddressingWithVoiceRecording,
  parameters: {
    ...AddressingWithVoiceRecording.parameters,
    viewport: { defaultViewport: "tabletComposer" },
  },
};

export const VoiceRecordingAt1280: Story = {
  ...AddressingWithVoiceRecording,
  parameters: {
    ...AddressingWithVoiceRecording.parameters,
    viewport: { defaultViewport: "desktopComposer" },
  },
};

export const ThreadVoiceRecordingAt360: Story = {
  ...AddressingWithVoiceRecording,
  args: {
    ...AddressingWithVoiceRecording.args,
    threadId: 42,
    onSetReplyInThread: undefined,
  },
  parameters: {
    ...AddressingWithVoiceRecording.parameters,
    setup: () => {
      useAddressed.getState().replace("general:t42", ["codex", "claude"]);
      useVoiceRec.setState({
        recordingKey: "t:42",
        startedAt: Date.now() - 12_000,
        busyKey: null,
      });
    },
    viewport: { defaultViewport: "recordingPhone" },
  },
};

export const ThreadReply: Story = {
  args: {
    threadId: 42,
    onSetReplyInThread: undefined,
  },
  parameters: {
    docs: {
      description: {
        story: "The composer inside an existing thread. It keeps a thread-scoped draft, omits the channel-level “reply in thread” toggle, and shows the sticky require-agent (@) control — on by default, so untagged replies are context rather than prompts.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByPlaceholderText("Reply in thread…")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("textbox"));
    const toggle = await canvas.findByTitle(
      "My replies here don't wake agents unless I tag one",
    );
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  },
};

export const RequireAgentDisabled: Story = {
  args: {
    threadId: 42,
    onSetReplyInThread: undefined,
  },
  parameters: {
    docs: {
      description: {
        story: "Thread composer with the sticky require-agent toggle switched off — the stored exception to the on-by-default behaviour, so agents answer untagged replies again.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox"));
    const toggle = await canvas.findByTitle(
      "My replies here don't wake agents unless I tag one",
    );
    await userEvent.click(toggle);
    await expect(
      canvas.findByTitle("Agents may reply to my messages without an @mention"),
    ).resolves.toHaveAttribute("aria-pressed", "false");
  },
};

export const ThreadToolbar: Story = {
  args: { threadId: 42, onSetReplyInThread: undefined, voiceOK: true },
  decorators: [(Story) => <div className="agora-thread" style={{ width: "min(720px, 100%)" }}><Story /></div>],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTitle("Attach files")).not.toBeVisible();
    await userEvent.click(canvas.getByRole("textbox"));
    const bot = canvas.getByTitle(/Choose which agents you're talking to/).getBoundingClientRect();
    const files = canvas.getByTitle("Attach files").getBoundingClientRect();
    const input = canvas.getByPlaceholderText("Reply in thread…").getBoundingClientRect();
    await expect(Math.abs(bot.top - files.top)).toBeLessThan(2);
    await expect(bot.top).toBeGreaterThanOrEqual(input.bottom);
  },
};

export const FocusRevealsTools: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox");
    const tools = canvas.getByTitle("Attach files");
    await expect(tools).not.toBeVisible();
    await userEvent.click(input);
    await expect(tools).toBeVisible();
    await userEvent.type(input, "Keep this draft");
    await userEvent.click(canvasElement.ownerDocument.body);
    await expect(tools).toBeVisible();
    await userEvent.clear(input);
    await userEvent.click(canvasElement.ownerDocument.body);
    await expect(tools).not.toBeVisible();
  },
};

const createSchedule = fn((body: unknown) => {
  const b = body as { text: string; run_at: number; thread_id: number | null };
  return { schedule: { id: "s-new", channel_id: "general", thread_id: b.thread_id, text: b.text, run_at: b.run_at } };
});
const scheduleRoutes = {
  "GET /api/auth/config": { schedule_presets: [60, 180] },
  "POST /api/channels/general/schedules": createSchedule,
};

/** Desktop: the chevron beside Send opens the presets; one schedules the
    typed text and clears the draft once the server has it. */
export const ScheduleFromChevron: Story = {
  parameters: {
    setup: () => { createSchedule.mockClear(); sendMessage.mockClear(); },
    apiRoutes: { ...meta.parameters.apiRoutes, ...scheduleRoutes },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    await userEvent.click(input);
    const more = canvas.getByRole("button", { name: "Schedule message" });
    expect(more).toBeDisabled();
    await userEvent.type(input, "standup at 5");
    await userEvent.click(more);
    const menu = await within(document.body).findByRole("dialog", { name: "Schedule message" });
    expect(within(menu).getByText(/^All times in /)).toBeVisible();
    const before = Math.round(Date.now() / 1000);
    await userEvent.click(within(menu).getByRole("button", { name: "In 3 hours" }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    const body = createSchedule.mock.calls[0][0] as { text: string; run_at: number; thread_id: number | null };
    expect(body.text).toBe("standup at 5");
    expect(body.thread_id).toBeNull();
    expect(body.run_at).toBeGreaterThanOrEqual(before + 3 * 3600);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(sendMessage).not.toHaveBeenCalled();
    await within(document.body).findByText(/^Scheduled for /);
  },
};

/** Custom time refuses the past and schedules a picked future time. */
export const ScheduleCustomTime: Story = {
  parameters: {
    setup: () => { createSchedule.mockClear(); },
    apiRoutes: { ...meta.parameters.apiRoutes, ...scheduleRoutes },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Message #general"), "later");
    await userEvent.click(canvas.getByRole("button", { name: "Schedule message" }));
    const menu = await within(document.body).findByRole("dialog", { name: "Schedule message" });
    await userEvent.click(within(menu).getByRole("button", { name: "Custom time" }));
    const field = within(menu).getByLabelText("Date and time") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2020-01-01T09:00" } });
    await userEvent.click(within(menu).getByRole("button", { name: "Schedule message" }));
    expect(await within(menu).findByRole("alert")).toHaveTextContent("Pick a time in the future");
    expect(createSchedule).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "2099-06-01T09:30" } });
    await userEvent.click(within(menu).getByRole("button", { name: "Schedule message" }));
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect((createSchedule.mock.calls[0][0] as { run_at: number }).run_at)
      .toBe(Math.round(new Date("2099-06-01T09:30").getTime() / 1000));
  },
};

/** Touch: holding Send opens the bottom sheet and never also sends; a quick
    tap still sends. */
export const LongPressSendOpensScheduleSheet: Story = {
  parameters: {
    setup: () => { createSchedule.mockClear(); sendMessage.mockClear(); },
    apiRoutes: { ...meta.parameters.apiRoutes, ...scheduleRoutes },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByPlaceholderText("Message #general");
    await userEvent.type(input, "hold me");
    const send = canvas.getByRole("button", { name: "Send" });
    fireEvent.pointerDown(send, { pointerType: "touch", clientX: 5, clientY: 5 });
    await new Promise(r => setTimeout(r, 600));
    fireEvent.pointerUp(send, { pointerType: "touch" });
    fireEvent.click(send);
    const sheet = await within(document.body).findByRole("dialog", { name: "Schedule message" });
    expect(sheet.tagName).toBe("DIALOG");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("hold me");
    // The lift of that same touch landing on an option does nothing; a fresh tap does.
    const preset = within(sheet).getByRole("button", { name: "In 1 hour" });
    fireEvent.click(preset, { detail: 1 });
    await new Promise(r => setTimeout(r, 50));
    expect(createSchedule).not.toHaveBeenCalled();
    fireEvent.pointerDown(preset, { pointerType: "touch" });
    fireEvent.click(preset, { detail: 1 });
    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Schedule message" })).toBeNull());
    createSchedule.mockClear();
    await userEvent.type(input, "hold me");
    fireEvent.pointerDown(send, { pointerType: "touch", clientX: 5, clientY: 5 });
    await new Promise(r => setTimeout(r, 600));
    fireEvent.pointerUp(send, { pointerType: "touch" });
    fireEvent.click(send);
    const reopened = await within(document.body).findByRole("dialog", { name: "Schedule message" });
    fireEvent.keyDown(reopened, { key: "Escape" });
    reopened.dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Schedule message" })).toBeNull());
    // A short tap sends as before.
    fireEvent.pointerDown(send, { pointerType: "touch", clientX: 5, clientY: 5 });
    fireEvent.pointerUp(send, { pointerType: "touch" });
    fireEvent.click(send);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(createSchedule).not.toHaveBeenCalled();
  },
};

/** Scheduled messages are text only: attachments keep the option off. */
export const ScheduleOffWithAttachments: Story = {
  parameters: {
    setup: () => stage([new File(["%PDF"], "release-plan.pdf", { type: "application/pdf" })]),
    apiRoutes: { ...meta.parameters.apiRoutes, ...scheduleRoutes },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Message #general"), "with a file");
    expect(canvas.getByRole("button", { name: "Schedule message" })).toBeDisabled();
  },
};
