import type { Meta, StoryObj } from "@storybook/react-native";
import { Attachments } from "./Attachments";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };
const previewSvg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="320">',
  '<rect width="440" height="320" fill="#1f2937"/>',
  '<rect x="24" y="24" width="105" height="272" rx="12" fill="#4f46e5"/>',
  '<rect x="145" y="24" width="271" height="272" rx="12" fill="#111827"/>',
  '<text x="280" y="170" fill="white" font-family="sans-serif" font-size="20" text-anchor="middle">Native preview</text>',
  "</svg>",
].join("");
const imageSource = () => ({
  uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSvg)}`,
});

const meta = {
  title: "Native/Messages/Attachments",
  component: Attachments,
  args: {
    session,
    imageSource,
    attachments: [
      { id: "preview", filename: "responsive-preview.png", mime: "image/png", size: 128_000 },
      { id: "plan", filename: "storybook-component-plan.pdf", mime: "application/pdf", size: 2_842_113 },
    ],
  },
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ImageAndFile: Story = {};
export const MessageImageGalleryNavigation: Story = {
  args: {
    session,
    imageSource,
    attachments: [
      { id: "first", filename: "first-dashboard.png", mime: "image/png", size: 128_000 },
      { id: "plan", filename: "plan.pdf", mime: "application/pdf", size: 2_842_113 },
      { id: "second", filename: "second-dashboard.png", mime: "image/png", size: 96_000 },
      { id: "third", filename: "third-dashboard.png", mime: "image/png", size: 88_000 },
    ],
  },
};
export const Video: Story = {
  args: {
    session,
    attachments: [{ id: "demo-video", filename: "launch-demo.mp4", mime: "video/mp4", size: 24_000_000 }],
  },
};
export const LongAndZeroByte: Story = {
  args: {
    session,
    imageSource,
    attachments: [
      { id: "empty", filename: "empty.txt", mime: "text/plain", size: 0 },
      {
        id: "long",
        filename: `${"native-responsive-contract-".repeat(4)}.pdf`,
        mime: "application/pdf",
        size: 9_437_184,
      },
    ],
  },
};
