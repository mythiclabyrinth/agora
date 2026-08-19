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
    providers: [
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "codex", label: "ChatGPT" },
    ],
    model: { value: "claude-sonnet-5", source: "default" },
    models: {
      anthropic: { value: "claude-sonnet-5", source: "default" },
      openai: { value: "gpt-4.1-mini", source: "default" },
      codex: { value: "gpt-5.1", source: "default" },
    },
    suggested_models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    suggested_models_by_provider: {
      anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
      openai: ["gpt-4.1-mini", "gpt-4.1"],
      codex: ["gpt-5.1", "gpt-4.1"],
    },
  },
  credentials: {
    openai: { configured: false, hint: null, source: "none" },
    anthropic: { configured: false, hint: null, source: "none" },
    oauth: {
      configured: false,
      source: "none",
      hint: null,
      account_id: null,
      redirect_uri: "http://localhost:1455/auth/callback",
    },
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
    model: { value: "claude-haiku-4-5-20251001", source: "config" },
    models: {
      ...emptySettings.search.models,
      anthropic: { value: "claude-haiku-4-5-20251001", source: "config" },
    },
  },
  credentials: {
    openai: { configured: true, hint: "sk-a…mnop", source: "config" },
    anthropic: { configured: true, hint: "ant-…here", source: "env" },
    oauth: emptySettings.credentials.oauth,
  },
};

const meta = {
  title: "Native/Screens/Instance settings",
  component: InstanceAiScreen,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": emptySettings,
      "PUT /api/instance/ai": configuredSettings,
      "POST /api/instance/ai/test": { ok: true, section: "voice" },
      "GET /api/instance/ai/codex/oauth/status": { status: "idle" },
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
      "GET /api/instance/ai/codex/oauth/status": { status: "idle" },
    },
  },
};
