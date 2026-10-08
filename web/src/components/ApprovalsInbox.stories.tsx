import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ApprovalItem } from "@agora/core";
import { fixtureGroups, fixtureMe, fixtureThreads } from "@agora/core/testing/fixtures";
import { Inbox } from "./Inbox";

const now = Date.now() / 1000;
const base: ApprovalItem = {
  kind: "channel", channel_id: "general", channel_name: "general", group_id: "product", group_name: "Product",
  thread_id: null, title: null, pending_count: 1,
  message: { ...fixtureThreads[0].root, id: 520, author_type: "agent", author_id: "claude-cli", author_name: "Claude", text: "May I run the release command?",
    thread_id: null, ts: now, meta: { approval_inbox: true, expires_at: now + 600,
      options: [{ id: "allow", label: "Approve", style: "primary" }, { id: "deny", label: "Reject" }] } },
};
const thread: ApprovalItem = {
  ...base, kind: "thread", thread_id: 42, title: "Launch planning", pending_count: 3,
  message: { ...base.message, id: 521, thread_id: 42, text: "Please approve the deployment plan." },
};
const form: ApprovalItem = {
  ...base, channel_id: "general", thread_id: 43, kind: "thread", title: "Review details",
  message: { ...base.message, id: 522, thread_id: 43, text: "Please fill in the release details.",
    meta: { approval_inbox: true, form: { fields: [], buttons: [] } } },
};

const meta = {
  title: "Web/Connected/ApprovalsInbox", component: Inbox,
  parameters: { setup: () => history.replaceState(null, "", "/inbox/approvals"), apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/groups": { groups: fixtureGroups },
    "GET /api/threads?limit=100": { threads: fixtureThreads },
    "GET /api/unreads": { items: [], total: 0 },
    "GET /api/approvals": { items: [base], total: 1 },
  } },
} satisfies Meta<typeof Inbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};
export const Empty: Story = { parameters: { apiRoutes: { "GET /api/approvals": { items: [], total: 0 } } } };
export const ThreadWithMore: Story = { parameters: { apiRoutes: { "GET /api/approvals": { items: [thread], total: 3 } } } };
export const ChannelAndThread: Story = { parameters: { apiRoutes: { "GET /api/approvals": { items: [base, thread], total: 4 } } } };
export const FormRequest: Story = { parameters: { apiRoutes: { "GET /api/approvals": { items: [form], total: 1 } } } };
