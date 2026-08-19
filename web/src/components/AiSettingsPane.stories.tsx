import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { AiSettingsPane } from "./AiSettingsPane";

const emptySettings = {
  voice: {
    enabled: true,
    available: false,
    provider: "openai",
    api_key: { configured: false, hint: null, source: "none" },
    stt_model: { value: "gpt-4o-mini-transcribe", source: "default" },
    tts_model: { value: "gpt-4o-mini-tts", source: "default" },
    tts_voice: { value: "alloy", source: "default" },
    suggested_tts_voices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"],
  },
  search: {
    enabled: true,
    available: false,
    provider: "anthropic",
    providers: [
      { id: "anthropic", label: "Anthropic (API key)" },
      { id: "openai", label: "OpenAI (API key)" },
      { id: "codex", label: "OpenAI via ChatGPT sign-in" },
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
      openai: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
      codex: ["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-4.1"],
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

const putAi = fn(async (_body: unknown) => configuredSettings);
const testAi = fn(async () => ({ ok: true, section: "voice" }));

const meta = {
  title: "Web/Connected/Instance settings",
  component: AiSettingsPane,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": emptySettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
      "GET /api/instance/ai/codex/oauth/status": { status: "idle" },
    },
    setup: () => {
      putAi.mockClear();
      testAi.mockClear();
      useUiState.setState({ panel: "settings" });
    },
  },
} satisfies Meta<typeof AiSettingsPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Settings")).resolves.toBeVisible();
    await expect(canvas.findByRole("tab", { name: "Features" })).resolves.toBeVisible();
    await expect(canvas.findByDisplayValue(/Anthropic \(API key\)/)).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Credentials" }));
    await expect(canvas.findByText("OpenAI API key")).resolves.toBeVisible();
    await expect(canvas.findByText("Anthropic API key")).resolves.toBeVisible();
    await expect(canvas.findByRole("button", { name: /Authorize ChatGPT/ })).resolves.toBeVisible();
  },
};

const envBackedSettings = {
  voice: {
    ...emptySettings.voice,
    enabled: false,
    available: false,
    api_key: { configured: true, hint: "sk-p…9f2c", source: "env" },
  },
  search: {
    ...emptySettings.search,
    available: true,
    model: { value: "claude-opus-5", source: "env" },
    models: {
      ...emptySettings.search.models,
      anthropic: { value: "claude-opus-5", source: "env" },
    },
  },
  credentials: {
    openai: { configured: true, hint: "sk-p…9f2c", source: "env" },
    anthropic: { configured: true, hint: "ant-…here", source: "env" },
    oauth: emptySettings.credentials.oauth,
  },
};

export const InheritedFromEnv: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": envBackedSettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
      "GET /api/instance/ai/codex/oauth/status": { status: "idle" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Credentials" }));
    await expect(canvas.findAllByText(/from server environment/)).resolves.toHaveLength(2);
    await expect(canvas.queryByRole("button", { name: "Clear saved key" })).toBeNull();
  },
};

export const Configured: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": configuredSettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
      "GET /api/instance/ai/codex/oauth/status": { status: "idle" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("tab", { name: "Credentials" }));
    await expect(canvas.findByText(/sk-a…mnop/)).resolves.toBeVisible();
    await expect(canvas.getByText(/from server environment/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Test OpenAI" }));
    await expect(testAi).toHaveBeenCalledWith({ section: "voice" });
  },
};
