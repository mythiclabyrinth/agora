import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Message } from "@agora/core";
import { MessageTableView } from "./MessageTableView";
import { message } from "../stories/fixtures/data";

/* A reconciliation table: the agent proposes rows it found, the reviewer
   corrects any cell in place, then accepts or declines each row on its own
   — or resolves whatever is left with the table-level buttons. */
const tableMessage: Message = {
  ...message,
  id: 71,
  text: "3 card transactions aren't in the ledger yet. Edit anything that looks wrong, then approve the ones to record.",
  meta: {
    table_id: "reconcile-2026-08-18",
    table: {
      columns: [
        { id: "date", label: "Date", kind: "readonly" },
        { id: "merchant", label: "Merchant", kind: "text" },
        { id: "amount", label: "Amount", kind: "number" },
        { id: "category", label: "Category", kind: "text" },
        { id: "points", label: "Points", kind: "number" },
      ],
      rows: [
        {
          id: "txn_1",
          cells: { date: "17 Aug", merchant: "Swiggy", amount: 669, category: "Food & Drink", points: 20 },
          actions: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "reject", label: "Reject", style: "secondary" },
          ],
        },
        {
          id: "txn_2",
          cells: { date: "17 Aug", merchant: "Cleartrip", amount: 23468, category: "Travel", points: 780 },
          actions: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "reject", label: "Reject", style: "secondary" },
          ],
        },
        {
          id: "txn_3",
          cells: { date: "18 Aug", merchant: "BluSmart", amount: 412, category: "Transport", points: 10 },
          actions: [
            { id: "approve", label: "Approve", style: "primary" },
            { id: "reject", label: "Reject", style: "secondary" },
          ],
        },
      ],
      buttons: [
        { id: "approve_all", label: "Approve all", style: "primary" },
        { id: "reject_all", label: "Reject all", style: "secondary" },
      ],
    },
    table_state: {
      txn_1: { date: "17 Aug", merchant: "Swiggy", amount: 669, category: "Food & Drink", points: 20 },
      txn_2: { date: "17 Aug", merchant: "Cleartrip", amount: 23468, category: "Travel", points: 780 },
      txn_3: { date: "18 Aug", merchant: "BluSmart", amount: 412, category: "Transport", points: 10 },
    },
    table_rows: {},
    table_submitted: null,
  },
};

const saveCell = fn(() => tableMessage);
const actOnRow = fn(() => tableMessage);
const submitTable = fn(() => tableMessage);

const meta = {
  title: "Web/Messages/Interactive table",
  component: MessageTableView,
  args: { message: tableMessage },
  decorators: [(Story) => <div style={{ width: "min(1040px, 100%)" }}><Story /></div>],
  parameters: {
    apiRoutes: {
      "POST /api/messages/71/table_cell": saveCell,
      "POST /api/messages/71/table_action": actOnRow,
      "POST /api/messages/71/table_submit": submitTable,
    },
  },
} satisfies Meta<typeof MessageTableView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every cell is editable and each row carries its own Approve / Reject. */
export const Editable: Story = {};

/** Typing into a cell and confirming it saves that value for everyone. */
export const EditingACell: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const category = canvas.getByLabelText("txn_2 Category");
    await userEvent.clear(category);
    await userEvent.type(category, "Flights{Enter}");
    await expect(saveCell).toHaveBeenCalled();
  },
};

/** Approving one row sends that row's values and leaves the rest alone.
    (The client's "Enter a number" guard has no web story: `type="number"`
    means the browser sanitizes a bad value before React sees it, so the
    guard is only reachable on mobile, where `keyboardType` is a hint.) */
export const ApprovingARow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole("button", { name: "Approve" })[0]);
    await expect(actOnRow).toHaveBeenCalled();
  },
};

/** One row approved: it locks on its own, the pressed button stays marked,
    and the other rows carry on being editable. */
export const RowApproved: Story = {
  args: {
    message: {
      ...tableMessage,
      meta: {
        ...tableMessage.meta,
        table_rows: {
          txn_1: {
            action_id: "approve",
            by: "tom",
            ts: 1787036893,
            values: { date: "17 Aug", merchant: "Swiggy", amount: 669, category: "Food & Drink", points: 20 },
          },
        },
      },
    },
  },
};

/** Approve all locked whatever was still open; nothing stays editable. */
export const Submitted: Story = {
  args: {
    message: {
      ...tableMessage,
      meta: {
        ...tableMessage.meta,
        table_submitted: {
          button_id: "approve_all",
          by: "tom",
          ts: 1787036893,
          rows: {
            txn_1: { date: "17 Aug", merchant: "Swiggy", amount: 669, category: "Food & Drink", points: 20 },
            txn_2: { date: "17 Aug", merchant: "Cleartrip", amount: 23468, category: "Travel", points: 780 },
            txn_3: { date: "18 Aug", merchant: "BluSmart", amount: 412, category: "Transport", points: 10 },
          },
        },
      },
    },
  },
};
