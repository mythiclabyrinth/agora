import type { Meta, StoryObj } from "@storybook/react-native";
import { ImagePreviewModal } from "./ImagePreviewModal";

const meta = {
  title: "Components/ImagePreviewModal",
  component: ImagePreviewModal,
  args: {
    source: require("../../assets/agents/codex.png"),
    filename: "landscape-preview.jpg",
    index: 1,
    total: 3,
    onPrevious: () => {},
    onNext: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof ImagePreviewModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
