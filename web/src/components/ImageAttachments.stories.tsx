import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import type { Attachment, Message } from "@agora/core";
import {
  fixtureAgents,
  fixtureMe,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { MessageItem } from "./MessageItem";

const images = {
  large: {
    id: "storybook-large-landscape.svg",
    filename: "release-dashboard-large.svg",
    mime: "image/svg+xml",
    size: 164_000,
  },
  small: {
    id: "storybook-small.svg",
    filename: "status-badge-small.svg",
    mime: "image/svg+xml",
    size: 18_000,
  },
  portrait: {
    id: "storybook-portrait.svg",
    filename: "mobile-review-portrait.svg",
    mime: "image/svg+xml",
    size: 112_000,
  },
  wide: {
    id: "storybook-wide.svg",
    filename: "timeline-wide.svg",
    mime: "image/svg+xml",
    size: 96_000,
  },
} satisfies Record<string, Attachment>;

const logFile = {
  id: "storybook-release-log.txt",
  filename: "release-validation.log",
  mime: "text/plain",
  size: 4_096,
} satisfies Attachment;

function messageWith(attachments: Attachment[]): Message {
  return {
    ...fixtureRootMessage,
    id: 80 + attachments.length,
    text: "Image attachments should stay inside the thread bubble and remain easy to preview.",
    reply_count: 0,
    reactions: [],
    attachments,
  };
}

function ImageMessage({ message }: { message: Message }) {
  return (
    <div className="agora-thread" style={{ width: "min(420px, 100%)", height: "auto" }}>
      <div className="ago-log">
        <MessageItem
          message={message}
          inThread
          isAdmin
          mentions={{}}
          onOpenThread={() => {}}
        />
      </div>
    </div>
  );
}

async function validateGallery(
  canvasElement: HTMLElement,
  expectedCount: number,
): Promise<void> {
  const gallery = canvasElement.querySelector<HTMLElement>(".ago-atts");
  if (!gallery) throw new Error("Missing image attachment gallery");
  const imageElements = [...gallery.querySelectorAll<HTMLImageElement>(".ago-att-img img")];
  expect(imageElements).toHaveLength(expectedCount);
  await waitFor(() => {
    expect(imageElements.every((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  }, { timeout: 5000 });
  expect(gallery.scrollWidth).toBeLessThanOrEqual(gallery.clientWidth);
  const galleryRect = gallery.getBoundingClientRect();
  for (const button of gallery.querySelectorAll<HTMLElement>(".ago-att-img")) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(galleryRect.left - 1);
    expect(rect.right).toBeLessThanOrEqual(galleryRect.right + 1);
  }
}

const meta = {
  title: "Web/Messages/Image attachments",
  component: ImageMessage,
  parameters: {
    layout: "centered",
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/agents": { agents: fixtureAgents },
      "GET /api/channels/general/pins": { pins: [] },
      "GET /api/channels/general/stars": { stars: [] },
    },
    docs: {
      description: {
        component: "Image messages rendered inside the real thread bubble width. Multi-image messages form a responsive two-column gallery; a single image preserves its natural proportions.",
      },
    },
  },
} satisfies Meta<typeof ImageMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneLargeImage: Story = {
  args: { message: messageWith([images.large]) },
  play: async ({ canvasElement }) => validateGallery(canvasElement, 1),
};

export const SmallImage: Story = {
  args: { message: messageWith([images.small]) },
  play: async ({ canvasElement }) => validateGallery(canvasElement, 1),
};

export const MixedSizes: Story = {
  args: { message: messageWith([images.large, images.small, images.portrait]) },
  play: async ({ canvasElement }) => validateGallery(canvasElement, 3),
};

export const FourMixedImages: Story = {
  args: { message: messageWith([images.large, images.small, images.portrait, images.wide]) },
  play: async ({ canvasElement }) => {
    await validateGallery(canvasElement, 4);
    const canvas = within(canvasElement);
    expect(canvas.getAllByRole("button", { name: /^Preview / })).toHaveLength(4);
  },
};

export const ImageWithFileChip: Story = {
  args: { message: messageWith([images.large, logFile]) },
  play: async ({ canvasElement }) => {
    await validateGallery(canvasElement, 1);
    const canvas = within(canvasElement);
    expect(canvas.getAllByRole("button", { name: /^Preview / })).toHaveLength(1);
    expect(canvas.getByTitle("Download release-validation.log")).toBeVisible();
  },
  parameters: {
    docs: {
      description: {
        story: "A single image keeps its natural proportions when a non-image download chip is present.",
      },
    },
  },
};
