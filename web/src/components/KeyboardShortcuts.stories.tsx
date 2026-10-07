import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within, fn, fireEvent } from "storybook/test";
import { fixtureGroups, fixtureMe } from "@agora/core/testing/fixtures";
import { currentPlatform } from "@agora/core";
import { useShortcuts } from "../hooks/useShortcuts";
import { leaveComposerForShortcuts } from "../state/shortcutFocus";
import { navigateAgoraHistory, useUiState, writeHistory } from "../state/ui";
import { inboxPathAfterReload } from "../lib/inboxReload";
import { useAddressing } from "./Composer";
import { useShortcutState } from "../state/shortcuts";
import { SearchPane } from "./SearchPane";
import { ShortcutsDialog } from "./ShortcutsDialog";

const markRead = fn(() => ({ ok: true, last_read_id: 0 }));
function Harness() {
  useShortcuts();
  const [clicks, setClicks] = useState(0);
  return <div>
    <button onClick={() => setClicks(n => n + 1)}>Action {clicks}</button>
    <div id="ago-log" style={{ padding: 16 }}>Message list</div>
    <textarea id="ago-msg" aria-label="Composer" onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); leaveComposerForShortcuts("channel"); e.currentTarget.blur(); }
    }} />
    <div className="agora-thread">
      <div id="ago-thread-log" style={{ padding: 16 }}>Thread messages</div>
      <textarea id="ago-thread-msg" aria-label="Thread composer" onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); leaveComposerForShortcuts("thread"); e.currentTarget.blur(); }
      }} />
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
    useUiState.setState({ sideCollapsed: !useUiState.getState().sideCollapsed });
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

export const GoSequenceFromMessageLog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("gu");
    await waitFor(() => expect(useUiState.getState().view.kind).toBe("inbox"));
    expect(useUiState.getState().inboxTab).toBe("unreads");
  },
};

export const ClickLogTypesGuysBeforeShortcutMode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole("textbox", { name: "Composer" });
    await userEvent.click(canvas.getByText("Message list"));
    await userEvent.keyboard("guys");
    expect(input).toHaveValue("guys");
    await userEvent.keyboard("{Escape}gu");
    await waitFor(() => expect(useUiState.getState().inboxTab).toBe("unreads"));
    expect(useUiState.getState().view.kind).toBe("inbox");
  },
};

export const InvalidGoTypesInThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useUiState.setState({ threadRoot: 42 });
    await userEvent.click(await canvas.findByRole("textbox", { name: "Thread composer" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("go");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Thread composer" })).toHaveValue("go"));
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
  },
};

export const GoTimeoutAndBareYType: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("g");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("g"), { timeout: 1800 });
    await userEvent.click(canvas.getByText("Message list"));
    await userEvent.keyboard("yes");
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("gyes"));
  },
};

export const GoFromButtonDoesNotType: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const action = await canvas.findByRole("button", { name: "Action 0" });
    await userEvent.click(action);
    await userEvent.keyboard("go");
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
    expect(action).toHaveFocus();
  },
};

export const GoTimerStopsWhenEditingElsewhere: Story = {
  render: () => <><Harness /><input aria-label="Other input" /></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("g");
    const other = canvas.getByRole("textbox", { name: "Other input" });
    await userEvent.click(other);
    await userEvent.keyboard("hello");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(other).toHaveValue("hello");
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
  },
};

export const GoThenEscapeOnlyTypesG: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("g{Escape}");
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("g");
    expect(markRead).not.toHaveBeenCalled();
  },
};

export const GoIgnoresNonPrintableKeys: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole("textbox", { name: "Composer" });
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}g{Tab}");
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}g{Shift}");
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
    await userEvent.keyboard("?");
    await waitFor(() => expect(input).toHaveValue("g?"));
  },
};

export const EnterFocusesComposer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Message list"));
    await userEvent.keyboard("{Enter}");
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveFocus();
    expect(canvas.getByRole("textbox", { name: "Composer" })).toHaveValue("");
  },
};

export const AgentPickerShortcutToggles: Story = {
  render: () => <><Harness /><button className="ago-addr-btn" data-draft-key="c:general">Talk to</button></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Talk to" });
    const modifier = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.body, { key: "@", code: "Digit2", shiftKey: true, ...modifier });
    expect(useAddressing.getState().pickerKey).toBe("c:general");
    fireEvent.keyDown(document.body, { key: "@", code: "Digit2", shiftKey: true, ...modifier });
    expect(useAddressing.getState().pickerKey).toBeNull();
  },
};

export const SearchReplacesShortcutsSheet: Story = {
  render: () => <><Harness /><SearchPane /><ShortcutsDialog /></>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    useShortcutState.getState().setSheetOpen(true);
    await canvas.findByRole("dialog", { name: "Keyboard shortcuts" });
    const modifier = currentPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.body, { key: "k", code: "KeyK", ...modifier });
    await waitFor(() => expect(canvas.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
    await expect(canvas.findByRole("dialog", { name: "Search conversations" })).resolves.toBeVisible();
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
      expect(navigateAgoraHistory("forward")).toBe(true);
      await waitFor(() => expect(location.pathname).toBe("/inbox/unreads"));
    } finally {
      history.replaceState(originalState, "", originalUrl);
    }
  },
};
