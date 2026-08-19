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
    await expect(canvas.findByText("AI & voice")).resolves.toBeVisible();
    await expect(canvas.getByText("openai")).toBeVisible();
    await expect(canvas.getByText("anthropic")).toBeVisible();
    await expect(canvas.getAllByRole("button", { name: "Test connection" })[0]).toBeDisabled();
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
