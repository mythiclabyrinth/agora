import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureThreads } from "@agora/core/testing/fixtures";
import ThreadsScreen, { RenameModal, ThreadViewSheet } from "../../app/(app)/threads";
import { usePrefs } from "../state/prefs";

const root = fixtureThreads[0].root;
const inboxThreads = [
  { ...fixtureThreads[0], root: { ...root, id: 42, alias: "Zulu planning" }, last_reply_ts: 400 },
  { ...fixtureThreads[0], root: { ...root, id: 43, alias: null, text: "Alpha launch notes" }, last_reply_ts: 300 },
  { ...fixtureThreads[0], root: { ...root, id: 44, alias: "Bravo review" }, last_reply_ts: 200 },
  { ...fixtureThreads[0], root: { ...root, id: 45, alias: null, text: "Charlie follow-up" }, last_reply_ts: 100 },
];

const meta = {
  title: "Native/Screens/Threads inbox",
  component: ThreadsScreen,
  parameters: {
    apiRoutes: { "GET /api/threads?limit=100": { threads: fixtureThreads } },
  },
} satisfies Meta<typeof ThreadsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnreadThread: Story = {};
/* Dialog opens prefilled with the thread's current alias. */
export const RenameDialog: Story = {
  render: () => (
    <RenameModal
      thread={{
        ...fixtureThreads[0],
        root: { ...fixtureThreads[0].root, alias: "Launch notes" },
      }}
      onClose={() => undefined}
    />
  ),
};
export const Empty: Story = {
  parameters: { apiRoutes: { "GET /api/threads?limit=100": { threads: [] } } },
};

export const Populated: Story = {
  parameters: { apiRoutes: { "GET /api/threads?limit=100": { threads: inboxThreads } } },
};

export const ViewOptionsSheet: Story = {
  render: () => (
    <ThreadViewSheet
      sort="az"
      filter="saved"
      onSort={() => undefined}
      onFilter={() => undefined}
      onClose={() => undefined}
    />
  ),
};

export const SavedThreadsSortedAZ: Story = {
  parameters: {
    apiRoutes: { "GET /api/threads?limit=100": { threads: inboxThreads } },
    setup: () => usePrefs.setState({ threadSort: "az", threadFilter: "saved" }),
  },
};

export const NoMatches: Story = {
  parameters: {
    apiRoutes: { "GET /api/threads?limit=100": { threads: [inboxThreads[0]] } },
    setup: () => usePrefs.setState({ threadFilter: "unset" }),
  },
};
