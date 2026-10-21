import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useJarvis } from "../../state/jarvis";
import { useUiState } from "../../state/ui";
import { JarvisChip } from "./JarvisChip";

const jarvisMe = { ...fixtureMe, jarvis: true, jarvis_hint: null };
const hint = "Connect ChatGPT in Settings → AI to enable Jarvis mode.";

const meta = {
  title: "Web/Jarvis/Chip",
  component: JarvisChip,
  decorators: [(Story) => <div className="topbar" style={{ padding: 12 }}><Story /></div>],
  parameters: { apiRoutes: { "GET /api/me": jarvisMe } },
} satisfies Meta<typeof JarvisChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", { name: "Jarvis mode" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip.title).toMatch(/^Turn on Jarvis mode and say “Hey Jarvis”/);
    await userEvent.click(chip);
    expect(useJarvis.getState().enabled).toBe(true);
    expect(useJarvis.getState().isOpen).toBe(true);
    expect(localStorage.getItem("agora_jarvis_enabled")).toBe("1");
  },
};

export const Listening: Story = {
  parameters: { setup: () => useJarvis.setState({ enabled: true, phase: "armed", wake: "listening" }) },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", { name: "Jarvis mode" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveClass("is-on");
    expect(chip).not.toHaveClass("is-error");
    expect(chip.title).toMatch(/^Listening for “Hey Jarvis” — click to turn off/);
    await userEvent.click(chip);
    expect(useJarvis.getState().enabled).toBe(false);
  },
};

export const WakeError: Story = {
  parameters: {
    setup: () => useJarvis.setState({
      enabled: true, phase: "armed", wake: "error",
      wakeError: "Microphone access is off. Allow it for Agora to use the wake word.",
    }),
  },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", { name: "Jarvis mode" });
    expect(chip).toHaveClass("is-on", "is-error");
    expect(chip.title).toMatch(/^Microphone access is off\. Allow it for Agora to use the wake word\./);
  },
};

export const UnavailableAdminHint: Story = {
  name: "Unavailable (admin hint)",
  parameters: { apiRoutes: { "GET /api/me": { ...fixtureMe, jarvis: false, jarvis_hint: hint } } },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", { name: "Jarvis mode" });
    expect(chip).toHaveClass("is-unavailable");
    expect(chip).toHaveAttribute("title", hint);
    await userEvent.click(chip);
    const body = within(document.body);
    await expect(body.findByText(hint)).resolves.toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Open settings" }));
    expect(useUiState.getState().panel).toBe("settings");
    expect(useJarvis.getState().enabled).toBe(false);
  },
};
