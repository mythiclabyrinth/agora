import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useMessageDrafts, type DraftRow } from "@agora/core";
import { DraftsInbox } from "./DraftsInbox";

const now = Date.now() / 1000;
const draftRows: DraftRow[] = [
  { channel_id: "general", thread_id: null, body: "We should ship this after review", meta: { addressed: ["codex"], reply_in_thread: true }, rev: 2, client_id: "other", updated_at: now, channel_name: "general", group_id: "product", group_name: "Product", thread_title: null },
  { channel_id: "general", thread_id: 42, body: "I can check the mobile flow", meta: { addressed: [], reply_in_thread: false }, rev: 1, client_id: "other", updated_at: now - 120, channel_name: "general", group_id: "product", group_name: "Product", thread_title: "Launch planning" },
];
const meta = { title: "Web/Connected/Drafts Inbox", component: DraftsInbox,
  parameters: { setup: () => useMessageDrafts.getState().setRows(draftRows) } } satisfies Meta<typeof DraftsInbox>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChannelAndThread: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.findByText("We should ship this after review")).resolves.toBeVisible();
  await expect(canvas.findByText(/Launch planning in/)).resolves.toBeVisible();
  await userEvent.click(canvas.getAllByRole("button", { name: "Options for draft in general" })[0]);
  await expect(canvas.findByText("Discard")).resolves.toBeVisible();
} };
export const Single: Story = { parameters: { setup: () => useMessageDrafts.getState().setRows(draftRows.slice(0, 1)) } };
export const Empty: Story = { parameters: { setup: () => useMessageDrafts.getState().setRows([]) } };
export const MenuDismissal: Story = { parameters: { setup: () => useMessageDrafts.getState().setRows(draftRows.slice(0, 1)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Options for draft in general" });
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(canvas.queryByRole("menu")).toBeNull();
    await userEvent.click(trigger);
    await userEvent.click(document.body);
    expect(canvas.queryByRole("menu")).toBeNull();
  } };
