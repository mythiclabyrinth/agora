import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { useAddressed, useMessageDrafts } from "@agora/core";
import { fixtureTemplates } from "@agora/core/testing/fixtures";
import { Composer } from "./Composer";
import { usePrefs } from "../state/prefs";

const agents = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];
const mentions = [...agents, { id: "alice", name: "Alice" }];
const send = fn(async () => {});

const meta = {
  title: "Native/Composer/Message composer",
  component: Composer,
  args: {
    placeholder: "Message #storybook",
    mentions,
    agents,
    addressKey: "general",
    groupId: "product",
    sending: false,
    threadToggle: true,
    onSend: send,
  },
  parameters: {
    /* The templates button prefetches its list, so every composer story needs
       the route — FixtureApiClient throws on unmocked paths. */
    apiRoutes: { "GET /api/groups/product/templates": { templates: fixtureTemplates } },
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const RestoredDraft: Story = {
  parameters: {
    setup: () => useMessageDrafts.setState({
      byConvo: { general: "This draft was waiting when I came back." },
    }),
  },
};

export const LongDraft: Story = {
  parameters: {
    setup: () => useMessageDrafts.setState({
      byConvo: {
        general: "A long draft that demonstrates how the composer expands while typing and returns to its compact height after it is sent. ".repeat(5),
      },
    }),
  },
};

export const ImageAndDocuments: Story = {
  args: {
    initialFiles: [
      {
        uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
          + "AAAADUlEQVR42mNk+M/wHwAEAQH/2qP8WQAAAABJRU5ErkJggg==",
        name: "release-dashboard.png",
        type: "image/png",
        size: 128_000,
      },
      {
        uri: "file:///storybook/release-plan.pdf",
        name: "release-plan.pdf",
        type: "application/pdf",
        size: 2_842_113,
      },
      {
        uri: "file:///storybook/very-long-document.docx",
        name: `${"responsive-attachment-review-".repeat(3)}.docx`,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 543_210,
      },
    ],
  },
};

export const AddressedToAgents: Story = {
  parameters: {
    setup: () => useAddressed.setState({ byConvo: { general: ["codex", "claude"] } }),
  },
};

export const Sending: Story = {
  args: {
    placeholder: "Message #storybook",
    mentions,
    agents,
    addressKey: "general",
    sending: true,
    threadToggle: true,
    onSend: send,
  },
};

export const ThreadReply: Story = {
  args: {
    placeholder: "Reply in thread",
    mentions,
    agents,
    addressKey: "general:t42",
    sending: false,
    threadToggle: false,
    requireAgentToggle: true,
    onSend: send,
  },
};

export const RequireAgentEnabled: Story = {
  args: {
    placeholder: "Reply in thread",
    mentions,
    agents,
    addressKey: "general:t42",
    sending: false,
    threadToggle: false,
    requireAgentToggle: true,
    onSend: send,
  },
  parameters: {
    setup: () => usePrefs.setState({ requireAgentThreads: ["general:t42"] }),
  },
};
