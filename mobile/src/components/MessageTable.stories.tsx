import type { Meta, StoryObj } from "@storybook/react-native";
import type { Message } from "@agora/core";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { MessageTable } from "./MessageTable";

/* Same reconciliation table as the web story, on a phone: the grid scrolls
   horizontally while every cell stays editable, and each row keeps its own
   Approve / Reject in trailing columns. */
const tableMessage: Message = {
  ...fixtureAgentMessage,
  id: 81,
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

const meta = {
  title: "Native/Messages/Interactive table",
  component: MessageTable,
  args: { message: tableMessage },
  parameters: {
    apiRoutes: {
      "POST /api/messages/81/table_cell": tableMessage,
      "POST /api/messages/81/table_action": tableMessage,
      "POST /api/messages/81/table_submit": tableMessage,
    },
  },
} satisfies Meta<typeof MessageTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Scrolls horizontally; every cell is editable and each row has its own
    Approve / Reject. */
export const Editable: Story = {};

/** Regression fixture for the compact iPhone message bubble: long imported
    merchant/title values remain aligned and readable with a visible gutter
    between editable fields, while the grid scrolls horizontally. */
export const NarrowIPhoneLongValues: Story = {
  args: {
    message: {
      ...tableMessage,
      text: "1 card transaction is missing. Review the imported values before approving it.",
      meta: {
        ...tableMessage.meta,
        table: {
          ...tableMessage.meta!.table!,
          columns: [
            { id: "title", label: "Title", kind: "text" },
            { id: "merchant", label: "Merchant", kind: "text" },
            { id: "amount", label: "Amount", kind: "number" },
            { id: "category", label: "Category", kind: "text" },
          ],
          rows: [
            {
              id: "txn_1",
              cells: {
                title: "HMS Host Services India",
                merchant: "HMS Host Services India Pvt Ltd",
                amount: 1028,
                category: "Food & Drink",
              },
              actions: [
                { id: "approve", label: "Approve", style: "primary" },
                { id: "reject", label: "Reject", style: "secondary" },
              ],
            },
          ],
        },
        table_state: {
          txn_1: {
            title: "HMS Host Services India",
            merchant: "HMS Host Services India Pvt Ltd",
            amount: 1028,
            category: "Food & Drink",
          },
        },
      },
    },
  },
  parameters: {
    layout: "fullscreen",
  },
};

/** One row approved locks that row alone — its cells go read-only and the
    pressed button stays marked while the rest of the table carries on. */
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

/** Approve all locked whatever was still open. */
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
