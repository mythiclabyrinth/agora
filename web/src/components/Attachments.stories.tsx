import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Attachments } from "./Attachments";
import { message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Atoms/Attachments",
  component: Attachments,
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "requirements", filename: "storybook-requirements.pdf", mime: "application/pdf", size: 428_032 },
        { id: "archive", filename: "component-fixtures.zip", mime: "application/zip", size: 2_842_113 },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filename = await canvas.findByText("storybook-requirements.pdf");
    expect(filename).toBeVisible();
    await expect(canvas.findByText("418.0 KB")).resolves.toBeVisible();
    expect(filename.closest(".ago-file-meta")).not.toBeNull();
    const card = filename.closest(".ago-att-file");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ago-file-icon")).not.toBeNull();
  },
};

export const Video: Story = {
  args: {
    message: {
      ...message,
      attachments: [{ id: "demo-video", filename: "launch-demo.mp4", mime: "video/mp4", size: 24_000_000 }],
    },
  },
  play: async ({ canvasElement }) => {
    const video = canvasElement.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).toHaveAttribute("preload", "metadata");
  },
};

export const VideoFallback: Story = {
  args: {
    message: {
      ...message,
      attachments: [{ id: "missing-video", filename: "missing-demo.mp4", mime: "video/mp4", size: 24_000_000 }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText("missing-demo.mp4")).toBeVisible());
    expect(canvasElement.querySelector("video")).toBeNull();
  },
};

export const ImageLightbox: Story = {
  args: {
    message: {
      ...message,
      attachments: [{
        id: "storybook-preview.svg",
        filename: "responsive-layout-preview.svg",
        mime: "image/svg+xml",
        size: 1_024,
      }],
    },
  },
  parameters: {
    docs: { description: { story: "Clicking an inline image opens the full-screen preview. Escape and backdrop clicks close it; this story finishes with the preview open for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    });
    await expect(dialog).toBeVisible();
    expect(within(dialog).queryByText("responsive-layout-preview.svg")).toBeNull();
    expect(within(dialog).getByAltText("responsive-layout-preview.svg")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    await expect(page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    })).resolves.toBeVisible();
  },
};

export const MessageImageGalleryNavigation: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "storybook-large-landscape.svg", filename: "first-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
        { id: "notes.pdf", filename: "notes.pdf", mime: "application/pdf", size: 2_048 },
        { id: "storybook-portrait.svg", filename: "second-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
        { id: "clip.mp4", filename: "clip.mp4", mime: "video/mp4", size: 4_096 },
        { id: "storybook-wide.svg", filename: "third-dashboard.svg", mime: "image/svg+xml", size: 1_024 },
      ],
    },
  },
  parameters: { docs: { description: { story: "A single message with images mixed among other files. The modal navigates only its three previewable images." } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Preview first-dashboard.svg" }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Image preview: first-dashboard.svg" });
    const firstControls = within(dialog);
    expect(firstControls.getByText("Image 1 of 3")).toBeVisible();
    expect(firstControls.getByRole("button", { name: "Previous image" })).toBeDisabled();
    await userEvent.keyboard("{ArrowRight}");
    await expect(page.findByRole("dialog", { name: "Image preview: second-dashboard.svg" })).resolves.toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Next image" }));
    expect(page.getByText("Image 3 of 3")).toBeVisible();
    expect(page.getByRole("button", { name: "Next image" })).toBeDisabled();
    await userEvent.keyboard("{ArrowLeft}");
    expect(page.getByText("Image 2 of 3")).toBeVisible();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(page.getByText("Image 2 of 3")).toBeVisible();
    const close = page.getByRole("button", { name: "Close image preview" });
    close.focus();
    await userEvent.keyboard("{Tab}");
    expect(page.getByRole("button", { name: "Previous image" })).toHaveFocus();
    await userEvent.click(close);
    expect(canvas.getByRole("button", { name: "Preview first-dashboard.svg" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Preview first-dashboard.svg" }));
  },
};

export const LongAndZeroByteFiles: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        {
          id: "empty",
          filename: "empty.txt",
          mime: "text/plain",
          size: 0,
        },
        {
          id: "long",
          filename: `${"responsive-component-contract-".repeat(4)}.pdf`,
          mime: "application/pdf",
          size: 9_437_184,
        },
      ],
    },
  },
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: {
    docs: { description: { story: "Exercises the edge cases for a zero-byte file (`0 B`) and truncation of a very long filename on a 320px-wide phone." } },
  },
};
