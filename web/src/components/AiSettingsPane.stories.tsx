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
    providers: ["anthropic", "openai", "codex"],
    api_key: { configured: false, hint: null, source: "none" },
    oauth: { configured: false, source: "none", hint: null, account_id: null },
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

const putAi = fn(async (_body: unknown) => configuredSettings);
const testAi = fn(async () => ({ ok: true, section: "voice" }));

const meta = {
  title: "Web/Connected/AI and voice settings",
  component: AiSettingsPane,
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": emptySettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
    },
    setup: () => {
      putAi.mockClear();
      testAi.mockClear();
      useUiState.setState({ panel: "ai" });
    },
  },
} satisfies Meta<typeof AiSettingsPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The panel header renders before the settings query resolves, so every
    // assertion on loaded content has to be a findBy*.
    await expect(canvas.findByText("AI & voice")).resolves.toBeVisible();
    await expect(canvas.findByText("openai")).resolves.toBeVisible();
    await expect(canvas.findByDisplayValue(/anthropic \(API key\)/)).resolves.toBeVisible();
    await expect(
      (await canvas.findAllByRole("button", { name: "Test connection" }))[0],
    ).toBeDisabled();
    // Inherited models show as placeholders, never as pre-filled values —
    // saving an untouched form must not pin the default into config.json.
    await expect(canvas.findByPlaceholderText(/gpt-4o-mini-transcribe \(default\)/))
      .resolves.toHaveValue("");
    await userEvent.click(canvas.getByRole("button", { name: "Save models" }));
    await expect(putAi).toHaveBeenCalledWith({
      voice: { stt_model: "", tts_model: "", tts_voice: "" },
    });
  },
};

/* Keys and models supplied by the deployment env, plus the voice kill-switch
   turned off: nothing is stored in config.json, so there is no "Clear saved
   key" and every model field is inherited. */
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
    api_key: { configured: true, hint: "ant-…here", source: "env" },
    model: { value: "claude-opus-5", source: "env" },
  },
};

export const InheritedFromEnv: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": envBackedSettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Env-sourced keys are not stored here, so clearing must not be offered.
    await expect(canvas.findAllByText(/from server environment/)).resolves.toHaveLength(2);
    await expect(canvas.queryByRole("button", { name: "Clear saved key" })).toBeNull();
    // The env model shows as a placeholder, leaving the override empty.
    await expect(canvas.findByPlaceholderText("claude-opus-5 (from env)"))
      .resolves.toHaveValue("");
  },
};

export const Configured: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": { ...fixtureMe, instance_admin: true },
      "GET /api/instance/ai": configuredSettings,
      "PUT /api/instance/ai": putAi,
      "POST /api/instance/ai/test": testAi,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(/sk-a…mnop/)).resolves.toBeVisible();
    await expect(canvas.getByText(/from server environment/)).toBeVisible();
    const testBtn = canvas.getAllByRole("button", { name: "Test connection" })[0];
    await userEvent.click(testBtn);
    await expect(testAi).toHaveBeenCalledWith({ section: "voice" });
  },
};
