import type { Meta, StoryObj } from "@storybook/react-native";
import React, { useEffect } from "react";
import { SpeakingBanner } from "./SpeakingBanner";
import { useNativeSpeech } from "../lib/nativeSpeech";
/* Turn the global flag on for this story only, and back off on leave. */
function SpeakingOn({ children }: React.PropsWithChildren) {
  useEffect(() => {
    useNativeSpeech.setState({ speaking: true });
    return () => useNativeSpeech.setState({ speaking: false });
  }, []);
  return children;
}
const meta = { title: "Native/Atoms/Speaking banner", component: SpeakingBanner,
  decorators: [(Story) => <SpeakingOn><Story /></SpeakingOn>],
} satisfies Meta<typeof SpeakingBanner>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Speaking: Story = {};
