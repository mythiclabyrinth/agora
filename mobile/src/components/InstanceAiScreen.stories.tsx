import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureMe } from "@agora/core/testing/fixtures";
import InstanceAiScreen from "../../app/(app)/instance-ai";

const emptySettings = {
  voice: {
    enabled: true,
    available: false,
    provider: "openai",
    api_key: { configured: false, hint: null, source: "none" },
    stt_model: { value: "gpt-4o-mini-transcribe", source: "default" },
    tts_model: { value: "gpt-4o-mini-tts", source: "default" },
    tts_voice: { value: "alloy", source: "default" },
    suggested_tts_voices: ["alloy", "shimmer", "nova"],
  },
  search: {
    enabled: true,
    available: false,
    provider: "anthropic",
    api_key: { configured: false, hint: null, source: "none" },
    model: { value: "claude-sonnet-5", source: "default" },
    suggested_models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
};

const configuredSettings = {
  voice: {
    ...emptySettings.voice,
    available: true,
    api_key: { configured: true, hint: "sk-a…mnop", source: "config" },
    tts_voice: { value: "shimmer", source: "config" },
  },
  search: {
    ...emptySettings.search,
    available: true,
    api_key: { configured: true, hint: "ant-…here", source: "env" },
    model: { value: "claude-haiku-4-5-20251001", source: "config" },
  },
};

const meta = {
  title: "Native/Screens/AI and voice",
  component: InstanceAiScreen,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": emptySettings,
      "PUT /api/instance/ai": configuredSettings,
      "POST /api/instance/ai/test": { ok: true, section: "voice" },
    },
  },
} satisfies Meta<typeof InstanceAiScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Configured: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": configuredSettings,
      "PUT /api/instance/ai": configuredSettings,
      "POST /api/instance/ai/test": { ok: true, section: "search" },
    },
  },
};
