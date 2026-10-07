import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within, fn, fireEvent } from "storybook/test";
import { fixtureGroups, fixtureMe } from "@agora/core/testing/fixtures";
import { useShortcuts } from "../hooks/useShortcuts";
import { navigateAgoraHistory, useUiState, writeHistory } from "../state/ui";
import { inboxPathAfterReload } from "../lib/inboxReload";
import { useAddressing } from "./Composer";

const markRead = fn(() => ({ ok: true, last_read_id: 0 }));
function Harness() {
  useShortcuts();
  const [clicks, setClicks] = useState(0);
  return <div>
    <button onClick={() => setClicks(n => n + 1)}>Action {clicks}</button>
    <div id="ago-log" style={{ padding: 16 }}>Message list</div>
    <textarea id="ago-msg" aria-label="Composer" />
    <div className="agora-thread">
      <div id="ago-thread-log" style={{ padding: 16 }}>Thread messages</div>
      <textarea id="ago-thread-msg" aria-label="Thread composer" />
    </div>
  </div>;
}
const meta = {
  title: "Web/Navigation/Keyboard behavior",
  component: Harness,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/unreads": { items: [], total: 0 },
      "PUT /api/channels/general/read": markRead,
    },
    setup: () => {
      markRead.mockClear();
      useAddressing.getState().setPickerKey(null);
      useUiState.setState({ sel: { g: "product", c: "general" }, view: { kind: "channel" }, threadRoot: null, threadExpanded: false });
    },
  },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TypeToFocusAndControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const action = await canvas.findByRole("button", { name: "Action 0" });
    await userEvent.click(action);
    await userEvent.keyboard(" ");
    await expect(canvas.findByRole("button", { name: "Action 2" })).resolves.toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.findByRole("button", { name: "Action 3" })).resolves.toBeVisible();
    await userEvent.click(canvas.getByText("Message list"));
    await userEvent.keyboard("good yarn");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("good yarn"));
  },
};

export const EscapeOutsideChannelDoesNotMarkRead: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Message list");
    useUiState.setState({ view: { kind: "inbox" } });
    await userEvent.click(canvas.getByText("Message list"));
    await userEvent.keyboard("{Escape}");
    expect(markRead).not.toHaveBeenCalled();
  },
};

export const OverlayEscapeDoesNotMarkRead: Story = {
  render: () => <><Harness /><div role="dialog" aria-label="Popup"><button>Popup control</button></div></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Popup control" }));
    await userEvent.keyboard("{Escape}");
    expect(markRead).not.toHaveBeenCalled();
  },
};

export const SourcesAndTemplateOverlaysBlockKeys: Story = {
  render: () => <><Harness /><div id="ago-sources-overlay" /><div className="ago-template-pop" /></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Message list"));
    await userEvent.keyboard("x{Escape}");
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
    expect(markRead).not.toHaveBeenCalled();
  },
};

export const SequenceSurvivesRender: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Message list");
    useUiState.setState({ view: { kind: "inbox" }, inboxTab: "threads" });
    await userEvent.click(canvas.getByRole("button", { name: "Action 0" }));
    await userEvent.keyboard("g");
    useUiState.setState({ sel: { g: "product", c: "responsive" } });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await userEvent.keyboard("u");
    await waitFor(() => expect(useUiState.getState().inboxTab).toBe("unreads"));
  },
};

export const PickerRequiresMountedAgentButton: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Message list");
    fireEvent.keyDown(document.body, { key: "@", code: "Digit2", shiftKey: true,
      [navigator.platform.includes("Mac") ? "metaKey" : "ctrlKey"]: true });
    expect(useAddressing.getState().pickerKey).toBeNull();
  },
};

export const EscapeWhileTypingKeepsThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useUiState.setState({ threadRoot: 42 });
    await userEvent.click(await canvas.findByRole("textbox", { name: "Thread composer" }));
    await userEvent.keyboard("{Escape}");
    expect(useUiState.getState().threadRoot).toBe(42);
  },
};

export const ThreadLogTypesInThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useUiState.setState({ threadRoot: 42 });
    await userEvent.click(await canvas.findByText("Thread messages"));
    await userEvent.keyboard("thread");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Thread composer" })).toHaveValue("thread"));
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
  },
};

export const HistoryKeepsBookmarkedInbox: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Message list");
    const originalUrl = location.pathname + location.search + location.hash;
    const originalState = history.state;
    try {
      history.replaceState(null, "", "/inbox/threads");
      writeHistory("/inbox/unreads", "push");
      expect(history.state).toEqual({ agoraHistoryIndex: 1 });
      expect(navigateAgoraHistory("back")).toBe(true);
      await waitFor(() => expect(location.pathname).toBe("/inbox/threads"));
      expect(history.state).toBeNull();
      expect(inboxPathAfterReload(location.pathname, "reload", history.state)).toBeNull();
      expect(navigateAgoraHistory("back")).toBe(false);
    } finally {
      history.replaceState(originalState, "", originalUrl);
    }
  },
};
